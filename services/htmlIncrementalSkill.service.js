'use strict';

const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');
const { stripHtmlToText } = require('../utils/stripHtml');
const {
  applySignalLimits,
  buildDataBlock,
  stripMarkdownFences,
  fetchNsePeTimeseries,
  fetchNseCmpTimeseries,
  buildMarketDataBlock,
} = require('./htmlSkill.service');

// ── Meta resolution ───────────────────────────────────────────────────────────

async function resolveCallMeta(callId) {
  if (!callId) return { fiscal_year: null, quarter: null };

  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { fiscal_year: true, quarter: true },
  });
  if (call) return { fiscal_year: call.fiscal_year ?? null, quarter: call.quarter ?? null };

  // Fallback for annual_reports or any other call_id source
  const sig = await prisma.transcriptSignalV2.findFirst({
    where:  { call_id: callId },
    select: { fiscal_year: true, quarter: true },
  });
  return { fiscal_year: sig?.fiscal_year ?? null, quarter: sig?.quarter ?? null };
}

// ── Base context helpers ──────────────────────────────────────────────────────

const BASE_OUTPUT_SELECT = { id: true, raw_html: true, text_summary: true, call_id: true, fiscal_year: true, quarter: true };

// If the skill has a global pin set, the base is ALWAYS that exact
// (fiscal_year, quarter, is_historic) — the same period for every ticker, no
// per-ticker "most recent" fallback. A ticker without an output at that exact
// period has no base at all (returns []), which callers already treat as "run
// historic first" — this keeps the anchor genuinely global rather than quietly
// drifting to a different period per ticker. Setting the pin doesn't backfill
// anything itself; it only changes which existing output counts as base.
async function fetchBaseContextOutputs(skill, ticker, excludeFiscalYear, excludeQuarter) {
  if (skill.pinned_fiscal_year != null) {
    const pinned = await prisma.htmlIncrementalSkillOutput.findFirst({
      where: {
        skill_id:    skill.id,
        ticker,
        fiscal_year: skill.pinned_fiscal_year,
        quarter:     skill.pinned_quarter ?? null,
        is_historic: skill.pinned_historic ?? true,
      },
      select: BASE_OUTPUT_SELECT,
    });
    return pinned ? [pinned] : [];
  }

  return prisma.htmlIncrementalSkillOutput.findMany({
    where: {
      skill_id: skill.id,
      ticker,
      NOT: { fiscal_year: excludeFiscalYear ?? null, quarter: excludeQuarter ?? null },
    },
    orderBy: { created_at: 'desc' },
    take:    skill.max_base_analyses,
    select:  BASE_OUTPUT_SELECT,
  });
}

// ── Period-anchored windowing for incremental mode ────────────────────────────
// Anchored on actual document periods (fiscal_year/quarter, resolved the same way
// as any call — never ingestion time / created_at), so a document that's backfilled
// late (e.g. a long-missing old quarter finally gets processed) never leaks into a
// "new" window just because it was inserted recently — its period is what's
// compared, not when it landed in the DB.

function parseFiscalYear(fy) {
  if (!fy) return null;
  const m = String(fy).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function parseQuarterNum(q) {
  if (!q) return null;
  const m = String(q).match(/(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

// Comparable rank for (fiscal_year, quarter) — higher = more recent.
function transcriptPeriodRank(fiscal_year, quarter) {
  const year = parseFiscalYear(fiscal_year);
  if (year == null) return null;
  return year * 10 + (parseQuarterNum(quarter) ?? 0);
}

/**
 * The base output's own period, used as the lower bound for "what's new". Reads
 * the output row's own fiscal_year/quarter directly — every real incremental/
 * historic run already sets these accurately, and backfillSeededAnchorPeriods.js
 * sets them for legacy seeded rows too. Falls back to resolving via call_id only
 * if a row still has no period set. When multiple base outputs are stitched in
 * (max_base_analyses > 1), the most recent of their periods is the anchor.
 * Returns { fiscal_year: null, quarter: null } if nothing resolves — caller
 * treats that as "no lower bound."
 */
async function resolveBaseAnchorPeriod(baseOutputs) {
  if (!baseOutputs.length) return { fiscal_year: null, quarter: null };

  const periods = await Promise.all(baseOutputs.map(o =>
    o.fiscal_year != null ? { fiscal_year: o.fiscal_year, quarter: o.quarter } : resolveCallMeta(o.call_id)
  ));
  let best = { fiscal_year: null, quarter: null };
  let bestRank = -Infinity;
  for (const p of periods) {
    const rank = transcriptPeriodRank(p.fiscal_year, p.quarter) ?? parseFiscalYear(p.fiscal_year);
    if (rank != null && rank > bestRank) {
      bestRank = rank;
      best = p;
    }
  }
  return best;
}

/**
 * Period-bounded signal window shared by both modes — always bounded above by the
 * target call's own period, so a run for e.g. Q3 never accidentally pulls in Q4
 * data that already landed in the DB. Capped to N distinct periods per source type
 * via applySignalLimits on top.
 *
 * - Incremental mode: anchor = the base's own resolved period (exclusive lower
 *   bound) — only the genuine delta since the base was last computed goes to the
 *   LLM. Callers must ensure at least one base output exists before calling
 *   assemblePrompt in incremental mode — see the "no base analysis found" gate in
 *   buildIncrementalHtmlSkillPrompt/runIncrementalHtmlSkill. If a base exists but
 *   its own period still can't be resolved (defensive fallback only — real and
 *   backfilled-seeded rows always have a period), this falls back to no lower
 *   bound rather than hard-failing.
 * - Historic mode: anchor = { fiscal_year: null, quarter: null } (no lower bound)
 *   — pulls up to N periods as of the target call, never leaking data from calls
 *   that landed in the DB after it.
 */
// Recency rank used purely to ORDER the eligible pool before capping to N periods.
// applySignalLimits picks the first N distinct period keys it encounters, assuming
// the input is already most-recent-first — it normally relies on call_date for that,
// but call_date is free text (e.g. "Jan 2026" vs "Oct 2025") and sorts lexically, not
// chronologically, so a small N (as incremental mode uses) can silently drop the
// actual most recent period — including the target call's own data. Sorting by the
// parsed fiscal_year/quarter rank instead fixes that, scoped to this incremental path.
function periodRankForSort(s) {
  return s.source_doc_type === 'annual_report'
    ? (parseFiscalYear(s.fiscal_year) ?? -Infinity)
    : (transcriptPeriodRank(s.fiscal_year, s.quarter) ?? -Infinity);
}

function applyPeriodBoundedWindow(signals, anchor, target, limits) {
  const anchorRank = transcriptPeriodRank(anchor.fiscal_year, anchor.quarter);
  const anchorYear = parseFiscalYear(anchor.fiscal_year);
  const targetRank = transcriptPeriodRank(target.fiscal_year, target.quarter);
  const targetYear = parseFiscalYear(target.fiscal_year);

  const pool = signals.filter(s => {
    if (s.source_doc_type === 'annual_report') {
      const y = parseFiscalYear(s.fiscal_year);
      if (y == null) return true;
      if (anchorYear != null && y <= anchorYear) return false;
      if (targetYear != null && y > targetYear) return false;
      return true;
    }
    const r = transcriptPeriodRank(s.fiscal_year, s.quarter);
    if (r == null) return true;
    if (anchorRank != null && r <= anchorRank) return false;
    if (targetRank != null && r > targetRank) return false;
    return true;
  });

  pool.sort((a, b) => periodRankForSort(b) - periodRankForSort(a));

  return applySignalLimits(pool, limits);
}

function formatBaseContextBlock(outputs, strip_html) {
  if (!outputs.length) return '';

  const sections = outputs.map((o, i) => {
    const label = [o.fiscal_year, o.quarter].filter(Boolean).join(' ') || 'baseline';
    const text  = strip_html
      ? (o.text_summary ?? stripHtmlToText(o.raw_html))
      : o.raw_html;
    const n = outputs.length > 1 ? ` [${i + 1} of ${outputs.length}]` : '';
    return [
      `--- PRIOR ANALYSIS${n} (${label}) ---`,
      text,
      `--- END PRIOR ANALYSIS${n} ---`,
    ].join('\n');
  });

  return '\n' + sections.join('\n\n') + '\n';
}

// ── Shared prompt assembly ────────────────────────────────────────────────────

async function assemblePrompt(skill, ticker, baseContextBlock, historic = false, targetFiscalYear = null, targetQuarter = null, baseOutputs = []) {
  const rawSignals = await querySignalsV2({ ticker });
  const signalTypeLimits = {
    transcript_signal_types:    skill.transcript_signal_types,
    ppt_signal_types:           skill.ppt_signal_types,
    annual_report_signal_types: skill.annual_report_signal_types,
  };

  const anchor = historic
    ? { fiscal_year: null, quarter: null }
    : await resolveBaseAnchorPeriod(baseOutputs);

  const limits = historic
    ? {
        max_transcript_qtrs:     skill.historic_max_transcript_qtrs     ?? skill.max_transcript_qtrs,
        max_ppt_qtrs:            skill.historic_max_ppt_qtrs            ?? skill.max_ppt_qtrs,
        max_annual_report_years: skill.historic_max_annual_report_years ?? skill.max_annual_report_years,
        ...signalTypeLimits,
      }
    : {
        max_transcript_qtrs:     skill.max_transcript_qtrs,
        max_ppt_qtrs:            skill.max_ppt_qtrs,
        max_annual_report_years: skill.max_annual_report_years,
        ...signalTypeLimits,
      };

  const signals = applyPeriodBoundedWindow(
    rawSignals,
    anchor,
    { fiscal_year: targetFiscalYear, quarter: targetQuarter },
    limits,
  );

  if (!signals.length) {
    const period = [targetFiscalYear, targetQuarter].filter(Boolean).join(' ') || 'the selected call';
    throw Object.assign(
      new Error(`No signals found for ${ticker} at or before ${period} on skill '${skill.slug}' — documents may not be ingested yet for this call. Select a call with ingested documents.`),
      { status: 400 },
    );
  }

  const dataBlock = buildDataBlock(signals);

  const mdTypes  = new Set(skill.market_data_signal_types ?? []);
  const mdMonths = historic ? (skill.historic_max_market_data_months ?? skill.max_market_data_months) : skill.max_market_data_months;
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && mdMonths != null) ? fetchNsePeTimeseries(ticker,  mdMonths) : null,
    (mdTypes.has('cmp') && mdMonths != null) ? fetchNseCmpTimeseries(ticker, mdMonths) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

  const systemPrompt = [
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill.skill_prompt,
    baseContextBlock,
    '--- SIGNALS ---',
    dataBlock,
    '--- END SIGNALS ---',
    marketDataBlock,
  ].join('\n');

  return { systemPrompt, userPrompt, signals, rawSignals };
}

// ── Named config resolution ───────────────────────────────────────────────────
// A HtmlIncrementalSkillConfig is a saved, alternate settings bundle for a
// skill (e.g. one per data-availability shape) — selected explicitly by key,
// never auto-detected (availability is checked by the admin elsewhere, ahead
// of picking a config). Prompt/filters/caps come entirely from the config
// when one is selected; only model/max_tokens/strip_html fall back to the
// skill's own value if left unset on the config, since those are execution
// knobs rather than analysis behavior.
async function resolveEffectiveSkill(skill, configKey) {
  if (!configKey) {
    return { effectiveSkill: skill, promptVKey: `${skill.slug}@${skill.updated_at.toISOString()}` };
  }

  const config = await prisma.htmlIncrementalSkillConfig.findUnique({
    where: { skill_id_key: { skill_id: skill.id, key: configKey } },
  });
  if (!config || !config.is_active) {
    throw Object.assign(new Error(`Config '${configKey}' not found for skill '${skill.slug}'`), { status: 404 });
  }

  const effectiveSkill = {
    ...skill,
    skill_prompt:                     config.skill_prompt,
    transcript_signal_types:          config.transcript_signal_types,
    ppt_signal_types:                 config.ppt_signal_types,
    annual_report_signal_types:       config.annual_report_signal_types,
    max_transcript_qtrs:              config.max_transcript_qtrs,
    max_ppt_qtrs:                     config.max_ppt_qtrs,
    max_annual_report_years:          config.max_annual_report_years,
    market_data_signal_types:         config.market_data_signal_types,
    max_market_data_months:           config.max_market_data_months,
    historic_max_transcript_qtrs:     config.historic_max_transcript_qtrs,
    historic_max_ppt_qtrs:            config.historic_max_ppt_qtrs,
    historic_max_annual_report_years: config.historic_max_annual_report_years,
    historic_max_market_data_months:  config.historic_max_market_data_months,
    model:      config.model      ?? skill.model,
    max_tokens: config.max_tokens ?? skill.max_tokens,
    strip_html: config.strip_html ?? skill.strip_html,
  };
  const promptVKey = `${skill.slug}:${configKey}@${config.updated_at.toISOString()}`;

  return { effectiveSkill, promptVKey };
}

// ── Public: dry-run prompt builder (no LLM) ───────────────────────────────────

async function buildIncrementalHtmlSkillPrompt({ slug, ticker, callId, historic = false, configKey = null }) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });
  const { effectiveSkill } = await resolveEffectiveSkill(skill, configKey);

  const { fiscal_year, quarter } = await resolveCallMeta(callId);
  const baseOutputs              = historic ? [] : await fetchBaseContextOutputs(effectiveSkill, ticker, fiscal_year, quarter);
  if (!historic && !baseOutputs.length) {
    throw Object.assign(
      new Error(`No base analysis found for ${ticker} on skill '${slug}' — run historic mode first before incremental.`),
      { status: 400 },
    );
  }
  const baseContextBlock         = formatBaseContextBlock(baseOutputs, effectiveSkill.strip_html);

  const { systemPrompt, userPrompt, signals, rawSignals } = await assemblePrompt(effectiveSkill, ticker, baseContextBlock, historic, fiscal_year, quarter, baseOutputs);

  return {
    skill: effectiveSkill,
    systemPrompt,
    userPrompt,
    signal_count:        signals.length,
    raw_signal_count:    rawSignals.length,
    base_context_count:  baseOutputs.length,
    fiscal_year,
    quarter,
    historic,
    configKey,
  };
}

// ── Public: full run ──────────────────────────────────────────────────────────

async function runIncrementalHtmlSkill({ slug, ticker, callId, force = false, historic = false, configKey = null }) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlIncrementalSkill is inactive: ${slug}`), { status: 400 });

  const { effectiveSkill, promptVKey } = await resolveEffectiveSkill(skill, configKey);
  const prompt_v                       = promptVKey;
  const { fiscal_year, quarter }       = await resolveCallMeta(callId);

  if (!force) {
    const cached = await prisma.htmlIncrementalSkillOutput.findFirst({
      where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, is_historic: historic },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  const baseOutputs = historic ? [] : await fetchBaseContextOutputs(effectiveSkill, ticker, fiscal_year, quarter);
  if (!historic && !baseOutputs.length) {
    throw Object.assign(
      new Error(`No base analysis found for ${ticker} on skill '${slug}' — run historic mode first before incremental.`),
      { status: 400 },
    );
  }
  const baseContextBlock = formatBaseContextBlock(baseOutputs, effectiveSkill.strip_html);

  const { systemPrompt, userPrompt } = await assemblePrompt(effectiveSkill, ticker, baseContextBlock, historic, fiscal_year, quarter, baseOutputs);

  const { text: raw_html_raw, usage } = await llmStream({
    model:      effectiveSkill.model,
    max_tokens: effectiveSkill.max_tokens,
    messages:   [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  const raw_html     = stripMarkdownFences(raw_html_raw);
  const text_summary = effectiveSkill.strip_html ? stripHtmlToText(raw_html) : null;

  logUsage(`html-incremental-skill:${slug}:${ticker}`, usage);

  const input_tokens  = usage?.prompt_tokens    ?? null;
  const output_tokens = usage?.completion_tokens ?? null;
  const cost_usd      = usage?.cost              ?? null;

  const existing = await prisma.htmlIncrementalSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, is_historic: historic },
  });

  const output = existing
    ? await prisma.htmlIncrementalSkillOutput.update({
        where: { id: existing.id },
        data:  { raw_html, text_summary, prompt_v, call_id: callId ?? 'unknown', model: effectiveSkill.model, input_tokens, output_tokens, cost_usd, is_historic: historic, config_key: configKey },
      })
    : await prisma.htmlIncrementalSkillOutput.create({
        data: {
          skill_id: skill.id,
          ticker,
          call_id:     callId ?? 'unknown',
          fiscal_year: fiscal_year ?? null,
          quarter:     quarter     ?? null,
          raw_html,
          text_summary,
          prompt_v,
          model:        effectiveSkill.model,
          input_tokens,
          output_tokens,
          cost_usd,
          is_historic: historic,
          config_key:  configKey,
        },
      });

  return { cached: false, output };
}

module.exports = {
  buildIncrementalHtmlSkillPrompt,
  runIncrementalHtmlSkill,
  fetchBaseContextOutputs,
  resolveBaseAnchorPeriod,
  transcriptPeriodRank,
  parseFiscalYear,
};
