'use strict';

const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');
const { runAgenticPipeline } = require('./htmlSkill.service.js');
const { stripHtmlToText } = require('../utils/stripHtml');
const { resolveConfigKeyForTicker } = require('./companyGroups');
const {
  applySignalLimits,
  buildDataBlock,
  stripMarkdownFences,
  buildMarketDataBlock,
  buildSourceMeta,
} = require('./htmlSkill.service');
const { createResolutionContext, resolveFormulaSeries } = require('../utils/formulaRegistry');

// ── Meta resolution ───────────────────────────────────────────────────────────

async function resolveCallMeta(callId) {
  if (!callId) return { fiscal_year: null, quarter: null };

  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { fiscal_year: true, quarter: true },
  });
  if (call) return { fiscal_year: call.fiscal_year ?? null, quarter: call.quarter ?? null };

  // Explicit fallback for annual_reports (where callId is a stringified BigInt)
  if (!isNaN(callId)) {
    const report = await prisma.annual_reports.findUnique({
      where: { id: BigInt(callId) },
      select: { fiscal_year: true }
    });
    if (report) return { fiscal_year: report.fiscal_year ?? null, quarter: null };
  }

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

/**
 * Trailing daily {latest, series} timeseries for a daily-native Kpi abbr
 * ('PRICE' for CMP, 'PE_DAILY' for PE), same shape htmlSkill.service.js's old
 * ad-hoc fetchNsePeTimeseries/fetchNseCmpTimeseries returned (so
 * buildMarketDataBlock needs no changes) — but resolved through the formula
 * registry instead of a raw nse_equity_new.pe/close query. This is what makes
 * PE automatically pick up PE_DAILY's own COALESCE(PE_CONSOLIDATED,
 * PE_STANDALONE) fallback (and any future registry fix) instead of being
 * stuck on the plain, less-authoritative `pe` column forever.
 *
 * resolveFormulaSeries walks the abbr's OWN definition (raw leaf or formula)
 * at every historical daily index — correct for PE_DAILY specifically, since
 * it's formula-derived, not a raw column itself. `dates` comes from the same
 * memoized daily seriesMap resolveFormulaSeries reads internally (same
 * resCtx instance -> same cached bulk fetch, no duplicate query), so the two
 * arrays are guaranteed index-aligned.
 */
async function fetchRegistryTimeseries(abbr, ticker, months) {
  const resCtx = createResolutionContext({ symbol: ticker, frequency: 'daily' });
  const [values, seriesMap] = await Promise.all([
    resolveFormulaSeries(abbr, resCtx, { frequency: 'daily' }),
    resCtx.getSeriesMap('daily'),
  ]);
  const anyAbbr = Object.keys(seriesMap)[0];
  const dates = anyAbbr ? seriesMap[anyAbbr].map((p) => p.date) : [];

  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const series = dates
    .map((date, i) => ({ date, value: values[i] ?? null }))
    .filter((p) => p.date >= cutoffStr);

  if (!series.length) return null;
  return { latest: series.at(-1), series };
}

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
    (mdTypes.has('pe')  && mdMonths != null) ? fetchRegistryTimeseries('PE_DAILY', ticker, mdMonths) : null,
    (mdTypes.has('cmp') && mdMonths != null) ? fetchRegistryTimeseries('PRICE',    ticker, mdMonths) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);


  return { dataBlock, marketDataBlock, signals, rawSignals };
}

// A config's key is just a string tag with no schema-level guarantee it
// exists under every skill — resolveConfigKeyForTicker (CompanyGroup side)
// happily returns a key that only exists for some skills, and any lens
// missing that key 404s at resolveEffectiveSkill/run time (or reports
// all-zero in L2 preview). This clone is how a new key gets seeded under
// every OTHER active skill at creation time so that gap can't open up by
// default — same shape as scripts/seedAvailabilityConfigs.js's original
// t1/t2/t3 seeding, now reused there instead of duplicated.
function defaultConfigFieldsFromSkill(skill) {
  return {
    data_extraction_prompt:           skill.data_extraction_prompt,
    html_template_prompt:             skill.html_template_prompt,
    transcript_signal_types:          skill.transcript_signal_types,
    ppt_signal_types:                 skill.ppt_signal_types,
    annual_report_signal_types:       skill.annual_report_signal_types,
    max_transcript_qtrs:              skill.max_transcript_qtrs,
    max_ppt_qtrs:                     skill.max_ppt_qtrs,
    max_annual_report_years:          skill.max_annual_report_years,
    market_data_signal_types:         skill.market_data_signal_types,
    max_market_data_months:           skill.max_market_data_months,
    historic_max_transcript_qtrs:     skill.historic_max_transcript_qtrs,
    historic_max_ppt_qtrs:            skill.historic_max_ppt_qtrs,
    historic_max_annual_report_years: skill.historic_max_annual_report_years,
    historic_max_market_data_months:  skill.historic_max_market_data_months,
    extraction_model:                 skill.extraction_model,
    fact_validation_model:            skill.fact_validation_model,
    html_template_model:              skill.html_template_model,
    visual_qa_model:                  skill.visual_qa_model,
    enable_data_validation:           skill.enable_data_validation,
    data_validation_loops:            skill.data_validation_loops,
    use_template_engine:              skill.use_template_engine,
    enable_html_validation:           skill.enable_html_validation,
    max_tokens: skill.max_tokens,
    strip_html: skill.strip_html,
  };
}

// ── Named config resolution ───────────────────────────────────────────────────
// A HtmlIncrementalSkillConfig is a saved, alternate settings bundle for a
// skill (e.g. one per data-availability shape). A run always needs one:
// explicitly via configKey, or auto-resolved from the ticker's CompanyGroup
// membership (CompanyGroup.config_key — see resolveConfigKeyForTicker in
// services/companyGroups/resolver.js). If neither yields a config, the run
// is blocked (400) rather than silently falling back to the skill's own
// top-level fields — every run must be tied to a known, deliberate config.
async function resolveRequiredConfigKey(ticker, configKey) {
  if (configKey) return configKey;

  const resolved = await resolveConfigKeyForTicker(ticker);
  if (resolved) return resolved;

  throw Object.assign(
    new Error(`No config resolved for ${ticker} — it isn't in any config-mapped company group. Assign it to a group with a config_key set, or pass configKey explicitly.`),
    { status: 400 },
  );
}

// Prompt/filters/caps come entirely from the config; only
// model/max_tokens/strip_html fall back to the skill's own value if left
// unset on the config, since those are execution knobs rather than analysis
// behavior.
async function resolveEffectiveSkill(skill, configKey) {
  const config = await prisma.htmlIncrementalSkillConfig.findUnique({
    where: { skill_id_key: { skill_id: skill.id, key: configKey } },
  });
  if (!config || !config.is_active) {
    throw Object.assign(new Error(`Config '${configKey}' not found for skill '${skill.slug}'`), { status: 404 });
  }

  const effectiveSkill = {
    ...skill,
    data_extraction_prompt:           config.data_extraction_prompt,
    html_template_prompt:             config.html_template_prompt,
    expected_json_schema:             config.expected_json_schema,
    json_validation_prompt:           config.json_validation_prompt,
    html_template_filename:           config.html_template_filename ?? skill.html_template_filename,
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
    
    extraction_model:                 config.extraction_model ?? skill.extraction_model,
    fact_validation_model:            config.fact_validation_model ?? skill.fact_validation_model,
    html_template_model:              config.html_template_model ?? skill.html_template_model,
    visual_qa_model:                  config.visual_qa_model ?? skill.visual_qa_model,
    enable_data_validation:           config.enable_data_validation ?? skill.enable_data_validation,
    data_validation_loops:            config.data_validation_loops ?? skill.data_validation_loops,
    use_template_engine:              config.use_template_engine ?? skill.use_template_engine,
    enable_html_validation:           config.enable_html_validation ?? skill.enable_html_validation,

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
  const resolvedConfigKey       = await resolveRequiredConfigKey(ticker, configKey);
  const { effectiveSkill }      = await resolveEffectiveSkill(skill, resolvedConfigKey);

  const { fiscal_year, quarter } = await resolveCallMeta(callId);
  const baseOutputs              = historic ? [] : await fetchBaseContextOutputs(effectiveSkill, ticker, fiscal_year, quarter);
  if (!historic && !baseOutputs.length) {
    throw Object.assign(
      new Error(`No base analysis found for ${ticker} on skill '${slug}' — run historic mode first before incremental.`),
      { status: 400 },
    );
  }
  const baseContextBlock         = formatBaseContextBlock(baseOutputs, effectiveSkill.strip_html);

  const { dataBlock, marketDataBlock, signals, rawSignals } = await assemblePrompt(effectiveSkill, ticker, baseContextBlock, historic, fiscal_year, quarter, baseOutputs);

  // Reconstruct the Phase 1 (data extraction) prompt exactly as runAgenticPipeline
  // builds it — enhancedExtractionPrompt mirrors runIncrementalHtmlSkill lines 476-479,
  // and the DATA BLOCK section mirrors runAgenticPipeline lines 682-689.
  const enhancedExtractionPrompt = [
    effectiveSkill.data_extraction_prompt,
    baseContextBlock,
  ].filter(Boolean).join('\n\n');

  const userPrompt = [
    enhancedExtractionPrompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\n');

  const systemPrompt = 'You are an expert data extraction agent. Output ONLY raw JSON.';

  return {
    skill: effectiveSkill,
    userPrompt,
    systemPrompt,
    signal_count:        signals.length,
    raw_signal_count:    rawSignals.length,
    base_context_count:  baseOutputs.length,
    fiscal_year,
    quarter,
    historic,
    configKey: resolvedConfigKey,
  };
}

// ── Public: full run ──────────────────────────────────────────────────────────

async function runIncrementalHtmlSkill({ slug, ticker, callId, force = false, historic = false, configKey = null }, job) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlIncrementalSkill is inactive: ${slug}`), { status: 400 });

  const resolvedConfigKey              = await resolveRequiredConfigKey(ticker, configKey);
  const { effectiveSkill, promptVKey } = await resolveEffectiveSkill(skill, resolvedConfigKey);
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

  const { dataBlock, marketDataBlock, signals } = await assemblePrompt(effectiveSkill, ticker, baseContextBlock, historic, fiscal_year, quarter, baseOutputs);

  const enhancedExtractionPrompt = [
    effectiveSkill.data_extraction_prompt,
    baseContextBlock,
  ].filter(Boolean).join('\n\n');

  const { raw_html: raw_html_unstripped, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker,
    extraction_model: effectiveSkill.extraction_model,
    fact_validation_model: effectiveSkill.fact_validation_model,
    html_template_model: effectiveSkill.html_template_model,
    visual_qa_model: effectiveSkill.visual_qa_model,
    max_tokens: effectiveSkill.max_tokens,
    data_extraction_prompt: enhancedExtractionPrompt,
    html_template_prompt: effectiveSkill.html_template_prompt,
    html_template_filename: effectiveSkill.html_template_filename,
    use_template_engine: effectiveSkill.use_template_engine,
    enable_data_validation: effectiveSkill.enable_data_validation,
    data_validation_loops: effectiveSkill.data_validation_loops,
    enable_html_validation: effectiveSkill.enable_html_validation,
    expected_json_schema: effectiveSkill.expected_json_schema,
    json_validation_prompt: effectiveSkill.json_validation_prompt,
    dataBlock,
    marketDataBlock,
    job,
    source_meta: buildSourceMeta(signals),
  });

  const raw_html     = stripMarkdownFences(raw_html_unstripped);
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
        data:  { raw_html, text_summary, prompt_v, call_id: callId ?? 'unknown', model: effectiveSkill.extraction_model, input_tokens, output_tokens, cost_usd, is_historic: historic, config_key: resolvedConfigKey, extracted_json, audit_logs },
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
          model:        effectiveSkill.extraction_model,
          input_tokens,
          output_tokens,
          cost_usd,
          is_historic: historic,
          config_key:  resolvedConfigKey,
          extracted_json,
          audit_logs,
        },
      });

  return { cached: false, output };
}

async function regenerateIncrementalHtmlSkill({ slug, ticker, callId, historic = false, configKey = null }, job) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlIncrementalSkill is inactive: ${slug}`), { status: 400 });

  const resolvedConfigKey = await resolveRequiredConfigKey(ticker, configKey);
  const { effectiveSkill } = await resolveEffectiveSkill(skill, resolvedConfigKey);
  const { fiscal_year, quarter } = await resolveCallMeta(callId);

  const existing = await prisma.htmlIncrementalSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, is_historic: historic },
  });

  if (!existing || !existing.extracted_json) {
    throw Object.assign(new Error(`No JSON found to regenerate HTML for ${ticker} on skill '${slug}'.`), { status: 400 });
  }

  const { raw_html: raw_html_unstripped, audit_logs, usage } = await runAgenticPipeline({
    ticker,
    extraction_model: effectiveSkill.extraction_model,
    fact_validation_model: effectiveSkill.fact_validation_model,
    html_template_model: effectiveSkill.html_template_model,
    visual_qa_model: effectiveSkill.visual_qa_model,
    max_tokens: effectiveSkill.max_tokens,
    html_template_prompt: effectiveSkill.html_template_prompt,
    html_template_filename: effectiveSkill.html_template_filename,
    use_template_engine: effectiveSkill.use_template_engine,
    enable_html_validation: effectiveSkill.enable_html_validation,
    job,
    pre_extracted_json: existing.extracted_json,
  });

  const raw_html = stripMarkdownFences(raw_html_unstripped);
  const text_summary = effectiveSkill.strip_html ? stripHtmlToText(raw_html) : null;

  logUsage(`html-incremental-skill-regenerate:${slug}:${ticker}`, usage);

  const output = await prisma.htmlIncrementalSkillOutput.update({
    where: { id: existing.id },
    data: { raw_html, text_summary, audit_logs },
  });

  return { cached: false, output };
}

module.exports = {
  buildIncrementalHtmlSkillPrompt,
  runIncrementalHtmlSkill,
  regenerateIncrementalHtmlSkill,
  fetchBaseContextOutputs,
  resolveBaseAnchorPeriod,
  resolveCallMeta,
  transcriptPeriodRank,
  parseFiscalYear,
  defaultConfigFieldsFromSkill,
};
