'use strict';

const prisma = require('../config/prisma');
const { querySignals } = require('./db/signals.db');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { computeSourceHash } = require('../utils/sourceHash');

// ─── L2 default prompt template ─────────────────────────────────────────────
// Overridable per lens via LensConfig.config.prompt_template

const L2_DEFAULT_PROMPT = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

{{DATA_BLOCK}}

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — 1-2 sentence synthesis in plain English>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each a short sentence>],
  "risks": [<up to 2 concerns, each a short sentence>]
}`;

// ─── Per metric_family normalization ranges ───────────────────────────────────

const NORM_RANGES = {
  growth:        { min: -50, max: 50  },
  profitability: { min: -20, max: 40  },
  governance:    { min: 0,   max: 1   },
  ofactor:       { min: 0,   max: 25  },
  management:    { min: 0,   max: 10  },
  customer:      { min: 0,   max: 100 },
  milestone:     { min: 0,   max: 1   },
  capital:       { min: 0,   max: 10  },
};

function normalizeValue(value, metricFamily) {
  const range = NORM_RANGES[metricFamily];
  if (!range) return value;
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (range.max === range.min) return 0;
  return (clamped - range.min) / (range.max - range.min);
}

function computeConfidenceInterval(signals, effectiveWeights) {
  const pairs = signals.map((s, i) => ({ conf: s.confidence ?? 0.7, w: effectiveWeights[i] }));
  const totalW = pairs.reduce((a, b) => a + Math.abs(b.w), 0) || 1;
  const variance = pairs.reduce((acc, { conf, w }) => {
    const uncertainty = 1 - conf;
    return acc + Math.pow(Math.abs(w) / totalW, 2) * Math.pow(uncertainty, 2);
  }, 0);
  const stdDev = Math.sqrt(variance);
  return { lo: -stdDev, hi: stdDev };
}

// ─── buildSignalSummary ──────────────────────────────────────────────────────
// Produces a compact ~20-50 line text block from signals for the L2 LLM prompt.
// Pure math — no LLM.

function buildSignalSummary(lensName, signals, mathResult) {
  const lines = [
    `LENS: ${lensName}`,
    `SIGNAL SUMMARY (${signals.length} signals, weighted aggregate z=${mathResult.z_score.toFixed(4)}):`,
    '',
  ];

  // Show up to 10 signals with their key fields; summarize the rest
  const withValue = signals.filter(s => s.value != null);
  const shown = withValue.slice(0, 10);
  const rest  = withValue.slice(10);

  for (const s of shown) {
    const period = [s.fiscal_year, s.quarter].filter(Boolean).join(' ');
    const periodStr = period ? ` [${period}]` : '';
    const stmt = s.statement ? ` — "${s.statement.slice(0, 60)}${s.statement.length > 60 ? '…' : ''}"` : '';
    lines.push(`  ${s.metric}: ${s.value}${s.unit ? ' ' + s.unit : ''}${periodStr} (${s.signal_type})${stmt}`);
  }

  if (rest.length > 0) {
    const vals = rest.map(s => s.value).filter(v => v != null);
    const avg  = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 'N/A';
    lines.push(`  ... ${rest.length} more signals: avg=${avg}`);
  }

  lines.push('');
  lines.push(`MATH: z=${mathResult.z_score.toFixed(4)}, CI=[${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}], n=${signals.filter(s => s.value != null).length}`);

  return lines.join('\n');
}

// ─── composeLens ─────────────────────────────────────────────────────────────

async function composeLens(callId, lensSlug) {
  const lensConfig = await prisma.lensConfig.findUnique({ where: { slug: lensSlug } });
  if (!lensConfig) throw new Error(`LensConfig "${lensSlug}" not found`);
  if (!lensConfig.is_active) throw new Error(`LensConfig "${lensSlug}" is inactive`);

  const { signal_filters: filters, weights: weightOverrides = [], aggregation = 'weighted_sum',
          model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate } = lensConfig.config;

  const signals = await querySignals({ callId, ...filters });

  if (signals.length === 0) {
    const empty = {
      score: null, status: 'WEAK', takeaway: 'No signals available for this lens.',
      key_metrics: {}, highlights: [], risks: [],
      z_score: 0, confidence_lo: 0, confidence_hi: 0, signal_count: 0, signals_snapshot: [],
    };
    await prisma.lensScore.upsert({
      where:  { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
      update: { z_score: 0, confidence_lo: 0, confidence_hi: 0, signal_count: 0,
                lens_config_v: lensConfig.version, lens_data: empty, is_stale: false, computed_at: new Date() },
      create: { call_id: callId, ticker: '', lens_slug: lensSlug, z_score: 0,
                confidence_lo: 0, confidence_hi: 0, signal_count: 0,
                lens_config_v: lensConfig.version, signals_snapshot: [], lens_data: empty },
    });
    return empty;
  }

  // ── Math step ──────────────────────────────────────────────────────────────
  const weightMap = new Map((weightOverrides || []).map(o => [o.metric, { w: o.w ?? 1.0, b: o.b ?? 0.0 }]));
  const effectiveWeights = [];
  let z = 0;
  const snapshot = [];

  for (const sig of signals) {
    if (sig.value == null || isNaN(sig.value)) continue;
    const override     = weightMap.get(sig.metric) ?? { w: sig.w, b: sig.b };
    const normalized   = normalizeValue(sig.value, sig.metric_family);
    const contribution = override.w * normalized + override.b;
    z += contribution;
    effectiveWeights.push(override.w);
    snapshot.push({ signal_id: sig.id, metric: sig.metric, value: sig.value, normalized, w: override.w, b: override.b, contribution });
  }

  if (aggregation === 'avg' && snapshot.length > 0) z = z / snapshot.length;

  const { lo, hi } = computeConfidenceInterval(signals.filter(s => s.value != null), effectiveWeights);
  const mathResult = { z_score: z, confidence_lo: z + lo, confidence_hi: z + hi };

  const ticker = signals[0]?.ticker ?? '';

  // ── L2 cache check by signals_hash ────────────────────────────────────────
  const signalsHash = computeSourceHash(
    signals.map(s => `${s.id}:${s.value}`).sort().join(',')
  );

  const existing = await prisma.lensScore.findUnique({
    where: { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
  });
  if (existing && existing.signals_hash === signalsHash && !existing.is_stale && existing.lens_data) {
    console.log(`[lensComposer] Cache hit for ${lensSlug}/${callId} — signals_hash match, skipping L2 LLM`);
    return { ...existing.lens_data, z_score: existing.z_score, signals_snapshot: existing.signals_snapshot };
  }

  // ── Build compact signal summary → L2 LLM call ───────────────────────────
  const signalSummary = buildSignalSummary(lensConfig.name, signals, mathResult);
  const promptTemplate = cfgPromptTemplate || L2_DEFAULT_PROMPT;
  const prompt = promptTemplate
    .replace('{{LENS_NAME}}', lensConfig.name)
    .replace('{{DATA_BLOCK}}', signalSummary);

  const model     = cfgModel     ?? 'anthropic/claude-haiku-4.5';
  const maxTokens = cfgMaxTokens ?? 800;

  console.log(`[lensComposer] Calling L2 LLM for lens "${lensSlug}" (${signals.length} signals, prompt: ${prompt.length} chars)`);
  const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });

  let lensResult;
  try {
    lensResult = parseJson(responseText);
  } catch (e) {
    console.error(`[lensComposer] Failed to parse L2 LLM response for "${lensSlug}":`, e.message);
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [] };
  }

  // Normalize the score from 0-100 to a z_score; prefer math z_score if LLM score absent
  const numericScore = typeof lensResult.score === 'number' ? lensResult.score / 100 : z;

  // ── Upsert LensScore ──────────────────────────────────────────────────────
  await prisma.lensScore.upsert({
    where:  { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
    update: {
      ticker,
      z_score:          numericScore,
      confidence_lo:    mathResult.confidence_lo,
      confidence_hi:    mathResult.confidence_hi,
      signal_count:     snapshot.length,
      lens_config_v:    lensConfig.version,
      signals_snapshot: snapshot,
      lens_data:        lensResult,
      signals_hash:     signalsHash,
      is_stale:         false,
      computed_at:      new Date(),
    },
    create: {
      call_id:          callId,
      ticker,
      lens_slug:        lensSlug,
      z_score:          numericScore,
      confidence_lo:    mathResult.confidence_lo,
      confidence_hi:    mathResult.confidence_hi,
      signal_count:     snapshot.length,
      lens_config_v:    lensConfig.version,
      signals_snapshot: snapshot,
      lens_data:        lensResult,
      signals_hash:     signalsHash,
    },
  });

  return { ...lensResult, z_score: numericScore, signals_snapshot: snapshot };
}

// ─── composeAllLenses ────────────────────────────────────────────────────────

async function composeAllLenses(callId) {
  const configs = await prisma.lensConfig.findMany({ where: { is_active: true } });
  const results = await Promise.all(
    configs.map(cfg => composeLens(callId, cfg.slug).catch(err => {
      console.error(`[lensComposer] Error composing lens "${cfg.slug}" for ${callId}:`, err.message);
      return null;
    }))
  );
  return Object.fromEntries(
    configs.map((cfg, i) => [cfg.slug, results[i]]).filter(([, v]) => v !== null)
  );
}

async function markLensesStale(callId) {
  const result = await prisma.lensScore.updateMany({
    where: { call_id: callId, is_stale: false },
    data:  { is_stale: true },
  });
  return result.count;
}

async function markLensStaleBySlug(lensSlug) {
  const result = await prisma.lensScore.updateMany({
    where: { lens_slug: lensSlug, is_stale: false },
    data:  { is_stale: true },
  });
  return result.count;
}

async function getLensScores(callId) {
  return prisma.lensScore.findMany({
    where:   { call_id: callId, is_stale: false },
    orderBy: { lens_slug: 'asc' },
  });
}

/**
 * Return lens scores for a call grouped by LensConfig.category.
 * Each group lists lenses in alphabetical order.
 * Scores include the full lens_data plus z_score/signal_count metadata.
 *
 * @param {string} callId
 * @param {string} [category]  Optional filter — only return one category
 * @returns {Promise<object>}  { callId, categories: { management: [...], opportunity: [...], deal: [...] } }
 */
async function getLensesByCategory(callId, category) {
  // Fetch active lens configs (optionally filtered by category)
  const configWhere = { is_active: true };
  if (category) configWhere.category = category;
  const configs = await prisma.lensConfig.findMany({ where: configWhere, orderBy: { slug: 'asc' } });

  if (configs.length === 0) return { callId, categories: {} };

  const slugs = configs.map(c => c.slug);
  const scores = await prisma.lensScore.findMany({
    where:   { call_id: callId, lens_slug: { in: slugs }, is_stale: false },
    orderBy: { lens_slug: 'asc' },
  });
  const scoreMap = new Map(scores.map(s => [s.lens_slug, s]));

  const categories = {};
  for (const cfg of configs) {
    const cat = cfg.category ?? 'uncategorized';
    if (!categories[cat]) categories[cat] = [];
    const ls  = scoreMap.get(cfg.slug);
    const ld  = ls?.lens_data ?? {};
    categories[cat].push({
      slug:         cfg.slug,
      name:         cfg.name,
      description:  cfg.description,
      category:     cat,
      computed:     !!ls,
      score:        ld.score        ?? null,
      status:       ld.status       ?? null,
      takeaway:     ld.takeaway     ?? null,
      key_metrics:  ld.key_metrics  ?? {},
      highlights:   ld.highlights   ?? [],
      risks:        ld.risks        ?? [],
      z_score:      ls?.z_score     ?? null,
      signal_count: ls?.signal_count ?? 0,
      computed_at:  ls?.computed_at  ?? null,
    });
  }

  return { callId, categories };
}

module.exports = {
  composeLens,
  composeAllLenses,
  markLensesStale,
  markLensStaleBySlug,
  getLensScores,
  getLensesByCategory,
};
