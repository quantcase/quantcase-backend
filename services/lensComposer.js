'use strict';

const prisma = require('../config/prisma');
const { querySignals } = require('./db/signals.db');
const { sortLensesByConfig } = require('../lib/insightLenses');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { lensOutputSchema } = require('../outputSchemas/lens');
const { computeSourceHash } = require('../utils/sourceHash');
const { fetchPeerMetrics, formatPeerMetricsBlock, fetchEquityMetrics, formatEquityMetricsBlock } = require('./peerMetrics');
const prowess = require('../lib/prowess');

const PEER_LENS_SLUGS = new Set(['industry-analysis', 'competition']);

// ─── Shareholding block for promoter-activity lens ───────────────────────────

// Quarter label from CSV (e.g. "Jun 2024") → fiscal quarter notation (e.g. "FY25 Q1")
const MONTH_TO_FY_QUARTER = {
  'Jun': { quarter: 'Q1', fyOffset: 1 },
  'Sep': { quarter: 'Q2', fyOffset: 1 },
  'Dec': { quarter: 'Q3', fyOffset: 1 },
  'Mar': { quarter: 'Q4', fyOffset: 0 },
};

function quarterLabelToFiscal(label) {
  // label = "Jun 2024", "Mar 2025", etc.
  const [mon, yearStr] = label.split(' ');
  const calYear = parseInt(yearStr, 10);
  const map = MONTH_TO_FY_QUARTER[mon];
  if (!map || !calYear) return label;
  const fy = (calYear + map.fyOffset).toString().slice(-2);
  return `FY${fy} ${map.quarter}`;
}

// Quarter label → ISO date of last day of that period
function quarterLabelToDate(label) {
  const [mon, yearStr] = label.split(' ');
  const calYear = parseInt(yearStr, 10);
  const lastDay = { Jun: '06-30', Sep: '09-30', Dec: '12-31', Mar: '03-31' };
  return lastDay[mon] ? `${calYear}-${lastDay[mon]}` : null;
}

function buildShareholdingBlock(ticker) {
  const identityMap = prowess.loadIdentityMap();
  const companyName = identityMap[ticker?.toUpperCase()];
  if (!companyName) return '';

  const { quarterLabels, companyMap } = prowess.loadShareholdingData();
  const row = companyMap[companyName];
  if (!row) return '';

  const lines = ['\nSHAREHOLDING PATTERN (from Prowess filings):'];
  lines.push('Period       | Promoter%  | Pledge%  | QoQ Δ    | Date');
  lines.push('-------------|------------|----------|----------|------------');

  let prevPromoters = null;
  let hasAnyData = false;

  for (let i = 0; i < prowess.SH_PERIOD_COUNT; i++) {
    const label = quarterLabels[i];
    const d = prowess.shPeriodData(row, i);
    if (d.promoters == null) continue;

    hasAnyData = true;
    const fiscal  = quarterLabelToFiscal(label);
    const date    = quarterLabelToDate(label) ?? '';
    const delta   = prevPromoters != null ? prowess.r2(d.promoters - prevPromoters) : null;
    const deltaStr = delta != null ? (delta >= 0 ? `+${delta}%` : `${delta}%`) : 'first';
    const pledgeStr = d.custodians != null ? `${d.custodians}%` : 'N/A';
    lines.push(`${fiscal.padEnd(12)} | ${String(d.promoters + '%').padEnd(10)} | ${pledgeStr.padEnd(8)} | ${deltaStr.padEnd(8)} | ${date}`);
    prevPromoters = d.promoters;
  }

  if (!hasAnyData) return '';

  lines.push('');
  lines.push(`Note: "Pledge%" = custodians column from Prowess (shares in demat/pledge). Δ = change vs prior quarter.`);

  return lines.join('\n');
}

// ─── L2 default prompt template ─────────────────────────────────────────────
// {{LENS_INSTRUCTIONS}} is injected from LensConfig.config.prompt_template (per-lens guidelines).
// Leave prompt_template null to omit the section entirely.

const L2_DEFAULT_PROMPT = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.
{{LENS_INSTRUCTIONS}}
{{DATA_BLOCK}}

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the key finding (e.g. "Margins expanding on operating leverage; FCF conversion risk remains — watch CFO/PAT ratio.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "EBITDA margin up 180 bps YoY on cost discipline.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Debt elevated; interest cover below 3x for 2 quarters.")
- "label" in top_signals: 2–5 words, title-case, human-readable (e.g. "Operating Cash Flow")
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, action-oriented synthesis leading with the key finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [
    {
      "signal_id": <string — id of the signal from the data block>,
      "metric": <string — metric name exactly as provided>,
      "label": <string — 2–5 word title-case human-readable label>,
      "guided_value": <number | null — management's forward-looking commitment or guidance, if present>,
      "guided_date": <string | null — ISO 8601 date YYYY-MM-DD, last day of the guidance target period, e.g. "2027-03-31" for FY2027, "2026-09-30" for FY2026 Q3>,
      "actual_value": <number | null — realised/reported value>,
      "actual_date": <string | null — ISO 8601 date YYYY-MM-DD, last day of the reported period, e.g. "2026-09-30" for FY2026 Q3, "2026-03-31" for FY2026>,
      "unit": <string | null — e.g. "Cr", "%", "x">,
      "delta": <number | null — actual_value minus guided_value; positive means beat, negative means miss; null if only one side available>,
      "delta_pct": <number | null — percentage delta relative to guided_value; null if not computable>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null — "tracking" when guidance exists but actuals not yet due>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — key evidence quote from the source, ≤80 chars>
    }
  ]
}

For top_signals: select 8–10 signals that most influenced this lens score — include ALL signals that have meaningful analytical value for this lens, not just the top few. For signals where management gave a forward-looking promise (guidance), populate guided_value/guided_date and compare against actual_value if the period has passed. If no actual is available yet, set direction to "tracking". For all dates use strict ISO 8601 format (YYYY-MM-DD) resolved to the last day of the implied period — never use free-text period labels like "FY2026 Q3".`;

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

// balance: optional object from LensConfig.config.balance, e.g. { milestone: 8, governance: 3, default: 3 }
// Within each signal_type group, signals with end_date are shown first (most trackable).
function buildSignalSummary(lensName, signals, mathResult, balance) {
  const lines = [
    `LENS: ${lensName}`,
    `SIGNAL SUMMARY (${signals.length} signals, weighted aggregate z=${mathResult.z_score.toFixed(4)}):`,
    '',
  ];

  const groups = new Map();
  for (const s of signals) {
    const t = s.signal_type ?? 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(s);
  }

  const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };
  const QUALITATIVE_TYPES = new Set(['milestone', 'industry', 'financial_health', 'customer']);

  const formatLine = s => {
    const period     = [s.fiscal_year, s.quarter].filter(Boolean).join(' ');
    const periodStr  = period ? ` [${period}]` : '';
    const periodType = s.period_type ? ` period_type=${s.period_type}` : '';
    const dates      = [s.start_date && `start=${s.start_date}`, s.end_date && `end=${s.end_date}`].filter(Boolean).join(' ');
    const datesStr   = dates ? ` (${dates})` : '';
    const impact     = s.impact ? ` impact=${s.impact}` : '';
    const stmt       = s.statement ? ` — "${s.statement}"` : '';
    return `  [id=${s.id}] ${s.metric}: ${s.value}${s.unit ? ' ' + s.unit : ''}${periodStr}${datesStr} (${s.signal_type}${periodType}${impact})${stmt}`;
  };

  for (const [type, groupSignals] of groups) {
    const cap = balance?.[type] ?? balance?.default ?? 15;

    // For qualitative signal types (milestone, industry, financial_health): include all signals
    // even when value is null, so the LLM sees the statement text. Sort: valued signals first,
    // then null-value signals; within each group by impact.
    // For other signal types: keep existing behaviour (value != null filter, sort by impact then end_date).
    let sorted;
    if (QUALITATIVE_TYPES.has(type)) {
      sorted = [...groupSignals].sort((a, b) => {
        const aHasVal = a.value != null ? 0 : 1;
        const bHasVal = b.value != null ? 0 : 1;
        if (aHasVal !== bHasVal) return aHasVal - bHasVal;
        const ia = IMPACT_ORDER[a.impact] ?? 3;
        const ib = IMPACT_ORDER[b.impact] ?? 3;
        return ia - ib;
      });
    } else {
      sorted = groupSignals
        .filter(s => s.value != null)
        .sort((a, b) => {
          const ia = IMPACT_ORDER[a.impact] ?? 3;
          const ib = IMPACT_ORDER[b.impact] ?? 3;
          if (ia !== ib) return ia - ib;
          return (a.end_date != null ? 0 : 1) - (b.end_date != null ? 0 : 1);
        });
    }

    const shown = sorted.slice(0, cap);
    const rest  = sorted.slice(cap);

    if (shown.length > 0) {
      lines.push(`  --- ${type.toUpperCase()} signals (${groupSignals.length} total, showing ${shown.length}) ---`);
      for (const s of shown) lines.push(formatLine(s));
    }

    if (rest.length > 0) {
      const summary = rest.map(s => {
        const dates = [s.start_date && `start=${s.start_date}`, s.end_date && `end=${s.end_date}`].filter(Boolean).join(' ');
        return `${s.metric}${dates ? ` (${dates})` : ''}`;
      }).join(', ');
      lines.push(`  ... ${rest.length} more ${type} signals: ${summary}`);
    }
  }

  lines.push('');
  lines.push(`MATH: z=${mathResult.z_score.toFixed(4)}, CI=[${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}], n=${signals.filter(s => s.value != null).length}`);

  return lines.join('\n');
}

// ─── Source priority deduplication ───────────────────────────────────────────
// When the same metric/period appears from multiple sources, keep the most
// authoritative one. prowess = audited financials > qe = interim PDF > transcript = LLM extract.

const SOURCE_PRIORITY = { prowess: 0, qe: 1, transcript: 2 };

function deduplicateSignals(signals) {
  const best = new Map();
  for (const sig of signals) {
    const key = `${sig.metric}|${sig.fiscal_year ?? ''}|${sig.quarter ?? ''}|${sig.start_date ?? ''}|${sig.end_date ?? ''}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, sig);
    } else {
      const existingPrio = SOURCE_PRIORITY[existing.source_type] ?? 99;
      const sigPrio      = SOURCE_PRIORITY[sig.source_type]      ?? 99;
      if (sigPrio < existingPrio) best.set(key, sig);
    }
  }
  return [...best.values()];
}

// ─── buildPeerSignalsBlock ────────────────────────────────────────────────────
// Fetches entity + industry L1 signals from each peer's latest call (same basic_industry)
// and formats them as a compact text block for injection into the competition / industry-analysis prompt.

const PEER_SIGNAL_TYPES  = ['entity', 'industry'];
const PEER_SIGNALS_CAP   = 10; // max signals shown per peer ticker (after filtering)
const PEER_IMPACT_ORDER  = { high: 0, medium: 1, low: 2 };

async function buildPeerSignalsBlock(callId, subjectTicker) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { basic_industry: true },
  });
  if (!call?.basic_industry) return '';

  const peerRows = await prisma.earnings_calls.findMany({
    where:   { basic_industry: call.basic_industry, NOT: { company: subjectTicker } },
    select:  { company: true, id: true, fiscal_year: true, quarter: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  // Pick the latest call per peer ticker
  const latestByTicker = new Map();
  for (const r of peerRows) {
    if (!latestByTicker.has(r.company)) latestByTicker.set(r.company, r);
  }
  if (latestByTicker.size === 0) return '';

  const lines = ['\nPEER L1 SIGNALS (competitor + industry signals from peer earnings calls):'];

  for (const [peerTicker, peerCall] of latestByTicker) {
    const raw = await prisma.extractedSignal.findMany({
      where: {
        call_id:        peerCall.id,
        signal_type:    { in: PEER_SIGNAL_TYPES },
        is_invalidated: false,
        NOT:            { metric: 'person' }, // exclude analyst/presenter names
      },
    });
    if (raw.length === 0) continue;

    // Sort high → medium → low, then by statement presence
    const sorted = raw.sort((a, b) => {
      const ia = PEER_IMPACT_ORDER[a.impact] ?? 3;
      const ib = PEER_IMPACT_ORDER[b.impact] ?? 3;
      if (ia !== ib) return ia - ib;
      return (b.statement ? 1 : 0) - (a.statement ? 1 : 0);
    }).slice(0, PEER_SIGNALS_CAP);

    lines.push(`\n  [${peerTicker} — ${peerCall.fiscal_year} ${peerCall.quarter}]`);
    for (const s of sorted) {
      const stmt = s.statement ? ` — "${s.statement}"` : '';
      lines.push(`    [id=${s.id}] ${s.metric}: ${s.raw_value ?? s.value ?? 'N/A'} (${s.signal_type} impact=${s.impact ?? 'N/A'})${stmt}`);
    }
  }

  if (lines.length === 1) return ''; // only header, no data
  lines.push('');
  return lines.join('\n');
}

// ─── composeLens ─────────────────────────────────────────────────────────────

async function composeLens(callId, lensSlug) {
  const lensConfig = await prisma.lensConfig.findUnique({ where: { slug: lensSlug } });
  if (!lensConfig) throw new Error(`LensConfig "${lensSlug}" not found`);
  if (!lensConfig.is_active) throw new Error(`LensConfig "${lensSlug}" is inactive`);

  const { signal_filters: filters, weights: weightOverrides = [], aggregation = 'weighted_sum',
          model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate,
          balance: cfgBalance } = lensConfig.config;

  const { include_historical, ...signalFilters } = filters ?? {};

  const currentSignals = await querySignals({ callId, ...signalFilters });

  let signals = currentSignals;
  if (include_historical) {
    // Resolve ticker from current signals; if none matched the filter, fall back to any signal on this call
    let ticker = currentSignals[0]?.ticker;
    if (!ticker) {
      const anySignal = await prisma.extractedSignal.findFirst({ where: { call_id: callId, is_invalidated: false } });
      ticker = anySignal?.ticker;
    }
    if (ticker) {
      const historicalSignals = await querySignals({ ticker, excludeCallId: callId, ...signalFilters });
      if (historicalSignals.length > 0) {
        console.log(`[lensComposer] "${lensSlug}" — appending ${historicalSignals.length} historical signals for ticker ${ticker}`);
        signals = [...currentSignals, ...historicalSignals];
      }
    }
  }

  const deduped = deduplicateSignals(signals);
  if (deduped.length < signals.length) {
    console.log(`[lensComposer] "${lensSlug}" — dropped ${signals.length - deduped.length} duplicate signals (prowess > qe > transcript)`);
  }
  signals = deduped;

  if (signals.length === 0) {
    const empty = {
      score: null, status: 'WEAK', takeaway: 'No signals available for this lens.',
      key_metrics: {}, highlights: [], risks: [], top_signals: [],
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
  // For promoter-activity, include the shareholding block in the hash so the
  // cache busts whenever the Prowess CSV is updated with new quarterly data.
  const shareholdingHashInput = lensSlug === 'promoter-activity' && ticker
    ? buildShareholdingBlock(ticker)
    : '';
  const signalsHash = computeSourceHash(
    signals.map(s => `${s.id}:${s.value}`).sort().join(',') + shareholdingHashInput
  );

  const existing = await prisma.lensScore.findUnique({
    where: { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
  });
  const cachedLensData = existing?.lens_data;
  const hasCachedTopSignals = Array.isArray(cachedLensData?.top_signals);
  if (existing && existing.signals_hash === signalsHash && existing.lens_config_v === lensConfig.version && !existing.is_stale && cachedLensData && hasCachedTopSignals) {
    console.log(`[lensComposer] Cache hit for ${lensSlug}/${callId} — signals_hash match, skipping L2 LLM`);
    return { ...cachedLensData, z_score: existing.z_score, signals_snapshot: existing.signals_snapshot };
  }

  // ── Build compact signal summary → L2 LLM call ───────────────────────────
  const signalSummary = buildSignalSummary(lensConfig.name, signals, mathResult, cfgBalance);
  const promptTemplate = cfgPromptTemplate || L2_DEFAULT_PROMPT;

  const lensInstructions = cfgPromptTemplate ? '' : '';

  // For industry-analysis and competition lenses, append peer KPI context block + peer L1 signals
  let peerBlock = '';
  if (PEER_LENS_SLUGS.has(lensSlug)) {
    const pm = await fetchPeerMetrics(callId);
    peerBlock = formatPeerMetricsBlock(pm);
    peerBlock += await buildPeerSignalsBlock(callId, ticker);
  }

  // For promoter-activity lens, append shareholding pattern from Prowess CSV
  let shareholdingBlock = '';
  if (lensSlug === 'promoter-activity' && ticker) {
    shareholdingBlock = buildShareholdingBlock(ticker);
    if (shareholdingBlock) {
      console.log(`[lensComposer] Appended shareholding block for ${ticker} (${prowess.SH_PERIOD_COUNT} periods)`);
    }
  }

  // For all lenses: append live PE + market-cap context (subject + industry peers)
  const em = await fetchEquityMetrics(callId);
  const equityBlock = formatEquityMetricsBlock(em);

  const prompt = promptTemplate
    .replace('{{LENS_NAME}}', lensConfig.name)
    .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
    .replace('{{DATA_BLOCK}}', signalSummary + shareholdingBlock + peerBlock + equityBlock);

  const model          = cfgModel     ?? 'anthropic/claude-haiku-4.5';
  const maxTokens      = cfgMaxTokens ?? 8000;
  const outputSchema   = lensConfig.config.output_schema ?? lensOutputSchema;

  console.log(`[lensComposer] Calling L2 LLM for lens "${lensSlug}" (${signals.length} signals, prompt: ${prompt.length} chars)`);
  const responseText = await llmStream({
    model,
    max_tokens:      maxTokens,
    messages:        [{ role: 'user', content: prompt }],
    response_format: outputSchema,
  });

  let lensResult;
  try {
    lensResult = parseJson(responseText);
  } catch (e) {
    console.error(`[lensComposer] Failed to parse L2 LLM response for "${lensSlug}":`, e.message);
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [], top_signals: [] };
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
      top_signals:  ld.top_signals  ?? [],
      z_score:      ls?.z_score     ?? null,
      signal_count: ls?.signal_count ?? 0,
      computed_at:  ls?.computed_at  ?? null,
    });
  }

  for (const cat of Object.keys(categories)) {
    categories[cat] = sortLensesByConfig(categories[cat], cat);
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
