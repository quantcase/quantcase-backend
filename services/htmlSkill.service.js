'use strict';

const { createHash } = require('crypto');
const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');

const PREVIEW_SKILL_SLUG = '__preview__';

// ── nse_equity_new market data helpers ───────────────────────────────────────

/**
 * Fetch P/E and CMP time-series from nse_equity_new for a ticker.
 * @param {string} ticker
 * @param {number} months  How many months of history to fetch (from skill.market_data_months)
 * @returns {object|null}  { latest, weekly, monthly, quarterly } or null when no data
 */
async function fetchNseMarketTimeseries(ticker, months) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT datetime, pe::float AS pe, close::float AS cmp
    FROM   nse_equity_new
    WHERE  symbol   = $1
      AND  pe       IS NOT NULL
      AND  close    IS NOT NULL
      AND  datetime >= NOW() - ($2 || ' months')::INTERVAL
    ORDER  BY datetime ASC
  `, ticker, String(months));

  if (!rows || rows.length === 0) return null;

  const weekly = rows.map(r => {
    const d = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    return {
      date: d.toISOString().slice(0, 10),
      pe:   r.pe  != null ? parseFloat(r.pe.toFixed(1))  : null,
      cmp:  r.cmp != null ? parseFloat(r.cmp.toFixed(1)) : null,
    };
  });

  // Monthly averages
  const monthMap = new Map();
  for (const r of rows) {
    const d   = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap.has(key)) monthMap.set(key, { peSum: 0, peCount: 0, cmpSum: 0, cmpCount: 0 });
    const m = monthMap.get(key);
    if (r.pe  != null) { m.peSum  += r.pe;  m.peCount++;  }
    if (r.cmp != null) { m.cmpSum += r.cmp; m.cmpCount++; }
  }
  const monthly = [...monthMap.entries()].map(([month, m]) => ({
    month,
    avg_pe:  m.peCount  ? parseFloat((m.peSum  / m.peCount).toFixed(1))  : null,
    avg_cmp: m.cmpCount ? parseFloat((m.cmpSum / m.cmpCount).toFixed(1)) : null,
  }));

  // Quarterly averages
  const qMap = new Map();
  for (const r of rows) {
    const d   = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const q   = Math.floor(d.getMonth() / 3) + 1;
    const key = `${d.getFullYear()}Q${q}`;
    if (!qMap.has(key)) qMap.set(key, { peSum: 0, peCount: 0, cmpSum: 0, cmpCount: 0 });
    const m = qMap.get(key);
    if (r.pe  != null) { m.peSum  += r.pe;  m.peCount++;  }
    if (r.cmp != null) { m.cmpSum += r.cmp; m.cmpCount++; }
  }
  const quarterly = [...qMap.entries()].map(([quarter, m]) => ({
    quarter,
    avg_pe:  m.peCount  ? parseFloat((m.peSum  / m.peCount).toFixed(1))  : null,
    avg_cmp: m.cmpCount ? parseFloat((m.cmpSum / m.cmpCount).toFixed(1)) : null,
  }));

  return { latest: weekly.at(-1), weekly, monthly, quarterly };
}

/**
 * Format nse_equity_new time-series into a prompt block.
 * All three frequency buckets are included so the LLM-generated HTML
 * can render toggle buttons to switch between them.
 */
function buildMarketDataBlock(data) {
  if (!data) return '';

  const lines = [
    '',
    '--- MARKET DATA (nse_equity_new) ---',
    `Latest: PE=${data.latest?.pe ?? 'N/A'}, CMP=₹${data.latest?.cmp ?? 'N/A'}, as_of=${data.latest?.date ?? 'N/A'}`,
    '',
    'Weekly:',
    'date\tpe\tcmp',
  ];
  for (const r of data.weekly) lines.push(`${r.date}\t${r.pe ?? ''}\t${r.cmp ?? ''}`);

  lines.push('', 'Monthly averages:', 'month\tavg_pe\tavg_cmp');
  for (const r of data.monthly) lines.push(`${r.month}\t${r.avg_pe ?? ''}\t${r.avg_cmp ?? ''}`);

  lines.push('', 'Quarterly averages:', 'quarter\tavg_pe\tavg_cmp');
  for (const r of data.quarterly) lines.push(`${r.quarter}\t${r.avg_pe ?? ''}\t${r.avg_cmp ?? ''}`);

  lines.push('--- END MARKET DATA ---');
  return lines.join('\n');
}

function stripMarkdownFences(text) {
  return text.replace(/^```(?:html)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Trim signals to respect per-source-type window limits and per-source signal type filters.
 * Signals are already ordered by call_date desc, so we just collect the N most
 * recent distinct period keys per source bucket.
 *
 * A limit of 0 means "include none"; null/undefined means "no limit".
 * An empty signal types array means "include all types for that source".
 *
 * @param {object[]} signals  Shaped V2 signals ordered by call_date desc
 * @param {object}   limits
 * @param {number|null}   limits.max_transcript_qtrs        Max distinct (fiscal_year, quarter) combos for transcript
 * @param {number|null}   limits.max_ppt_qtrs               Max distinct (fiscal_year, quarter) combos for ppt
 * @param {number|null}   limits.max_annual_report_years    Max distinct fiscal_year values for annual_report
 * @param {string[]|null} limits.transcript_signal_types    Allowed signal types for transcript (null = all)
 * @param {string[]|null} limits.ppt_signal_types           Allowed signal types for ppt (null = all)
 * @param {string[]|null} limits.annual_report_signal_types Allowed signal types for annual_report (null = all)
 */
function applySignalLimits(signals, {
  max_transcript_qtrs,
  max_ppt_qtrs,
  max_annual_report_years,
  transcript_signal_types,
  ppt_signal_types,
  annual_report_signal_types,
}) {
  const hasLimit = v => v != null;
  const transcriptTypeSet   = transcript_signal_types?.length   ? new Set(transcript_signal_types)   : null;
  const pptTypeSet          = ppt_signal_types?.length          ? new Set(ppt_signal_types)          : null;
  const annualTypeSet       = annual_report_signal_types?.length ? new Set(annual_report_signal_types) : null;

  const hasAnyFilter = hasLimit(max_transcript_qtrs) || hasLimit(max_ppt_qtrs) || hasLimit(max_annual_report_years)
    || transcriptTypeSet || pptTypeSet || annualTypeSet;
  if (!hasAnyFilter) return signals;

  const transcriptAllowed = new Set();
  const pptAllowed        = new Set();
  const annualAllowed     = new Set();
  const transcriptLimit   = max_transcript_qtrs     ?? Infinity;
  const pptLimit          = max_ppt_qtrs            ?? Infinity;
  const annualLimit       = max_annual_report_years  ?? Infinity;

  // First pass: collect the allowed period keys in recency order (respecting signal type filters)
  for (const s of signals) {
    const docType = s.source_doc_type;
    if (docType === 'annual_report') {
      if (annualTypeSet && !annualTypeSet.has(s.signal_type)) continue;
      if (annualAllowed.size < annualLimit) annualAllowed.add(s.fiscal_year);
    } else if (docType === 'ppt') {
      if (pptTypeSet && !pptTypeSet.has(s.signal_type)) continue;
      const key = `${s.fiscal_year}|${s.quarter}`;
      if (pptAllowed.size < pptLimit) pptAllowed.add(key);
    } else {
      // transcript (and any unrecognised doc type)
      if (transcriptTypeSet && !transcriptTypeSet.has(s.signal_type)) continue;
      const key = `${s.fiscal_year}|${s.quarter}`;
      if (transcriptAllowed.size < transcriptLimit) transcriptAllowed.add(key);
    }
  }

  // Second pass: keep only signals that pass both type filter and period window
  return signals.filter(s => {
    const docType = s.source_doc_type;
    if (docType === 'annual_report') {
      if (annualTypeSet && !annualTypeSet.has(s.signal_type)) return false;
      return annualAllowed.has(s.fiscal_year);
    }
    if (docType === 'ppt') {
      if (pptTypeSet && !pptTypeSet.has(s.signal_type)) return false;
      return pptAllowed.has(`${s.fiscal_year}|${s.quarter}`);
    }
    // transcript
    if (transcriptTypeSet && !transcriptTypeSet.has(s.signal_type)) return false;
    return transcriptAllowed.has(`${s.fiscal_year}|${s.quarter}`);
  });
}

/**
 * Format V2 signals into a JSON DATA_BLOCK for the LLM prompt.
 * Includes all meaningful fields from the shaped TranscriptSignalV2 row.
 */
function buildDataBlock(signals) {
  if (!signals || signals.length === 0) return 'No signals found for this ticker/period.';

  // Header row
  const COLS = ['signal_type','metric','metric_family','fiscal_year','quarter','call_date',
                'source_doc_type','source_context','impact','severity','statement'];

  const flattenDetails = (data) => {
    const d = data?.details ?? {};
    return Object.entries(d)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('; ');
  };

  const flattenMeasures = (measures) => {
    if (!measures?.length) return '';
    return measures.map(m => {
      const parts = [];
      if (m.value != null)      parts.push(`val=${m.value}${m.unit ? m.unit : ''}`);
      if (m.value_raw != null)  parts.push(`raw=${m.value_raw}`);
      if (m.period?.start)      parts.push(`from=${m.period.start}`);
      if (m.period?.end)        parts.push(`to=${m.period.end}`);
      if (m.direction)          parts.push(`dir=${m.direction}`);
      return parts.join(' ');
    }).join(' | ');
  };

  const rows = signals.map(s => {
    const cols = COLS.map(k => {
      const v = s[k] ?? (s.data?.[k]) ?? '';
      return String(v).replace(/\n/g, ' ').replace(/\|/g, '/');
    });
    const details  = flattenDetails(s.data);
    const measures = flattenMeasures(s.measures);
    return [...cols, details, measures].join('\t');
  });

  return [COLS.concat(['details', 'measures']).join('\t'), ...rows].join('\n');
}

/**
 * Build the system + user prompt for an HtmlSkill without calling the LLM.
 * Returns { skill, signals, systemPrompt, userPrompt, signal_count }.
 */
async function buildHtmlSkillPrompt({
  slug, ticker,
  transcript_signal_types, ppt_signal_types, annual_report_signal_types,
  max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
}) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });

  const rawSignals = await querySignalsV2({ ticker });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs:        max_transcript_qtrs        ?? skill.max_transcript_qtrs,
    max_ppt_qtrs:               max_ppt_qtrs               ?? skill.max_ppt_qtrs,
    max_annual_report_years:    max_annual_report_years     ?? skill.max_annual_report_years,
    transcript_signal_types:    transcript_signal_types     ?? skill.transcript_signal_types,
    ppt_signal_types:           ppt_signal_types            ?? skill.ppt_signal_types,
    annual_report_signal_types: annual_report_signal_types  ?? skill.annual_report_signal_types,
  });
  const dataBlock = buildDataBlock(signals);

  let marketDataBlock = '';
  if (skill.market_data_months != null) {
    const marketData = await fetchNseMarketTimeseries(ticker, skill.market_data_months);
    marketDataBlock = buildMarketDataBlock(marketData);
  }

  const systemPrompt = [
    'You are a financial analyst assistant.',
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill.skill_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\n');

  return { skill, signals, systemPrompt, userPrompt, signal_count: signals.length, raw_signal_count: rawSignals.length };
}

/**
 * Run an HtmlSkill against a ticker.
 * Returns the saved HtmlSkillOutput row.
 *
 * @param {object} opts
 * @param {string}  opts.slug
 * @param {string}  opts.ticker
 * @param {string}  [opts.fiscal_year]
 * @param {string}  [opts.quarter]
 * @param {boolean} [opts.force]       Skip cache and always re-run
 */
async function runHtmlSkill({
  slug, ticker, fiscal_year, quarter, force = false,
  transcript_signal_types, ppt_signal_types, annual_report_signal_types,
  max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
}) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlSkill is inactive: ${slug}`), { status: 400 });

  const prompt_v = `${slug}@${skill.updated_at.toISOString()}`;

  // Cache check — skip if force=true
  if (!force) {
    const cached = await prisma.htmlSkillOutput.findFirst({
      where: {
        skill_id: skill.id,
        ticker,
        fiscal_year: fiscal_year ?? null,
        quarter: quarter ?? null,
      },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  // Fetch all V2 signals for ticker, then apply per-source type filters and window limits
  const rawSignals = await querySignalsV2({ ticker });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs:        max_transcript_qtrs        ?? skill.max_transcript_qtrs,
    max_ppt_qtrs:               max_ppt_qtrs               ?? skill.max_ppt_qtrs,
    max_annual_report_years:    max_annual_report_years     ?? skill.max_annual_report_years,
    transcript_signal_types:    transcript_signal_types     ?? skill.transcript_signal_types,
    ppt_signal_types:           ppt_signal_types            ?? skill.ppt_signal_types,
    annual_report_signal_types: annual_report_signal_types  ?? skill.annual_report_signal_types,
  });

  const dataBlock = buildDataBlock(signals);

  let marketDataBlock = '';
  if (skill.market_data_months != null) {
    const marketData = await fetchNseMarketTimeseries(ticker, skill.market_data_months);
    marketDataBlock = buildMarketDataBlock(marketData);
  }

  const systemPrompt = [
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill.skill_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\n');

  const { text: raw_html_raw, usage } = await llmStream({
    model:      skill.model,
    max_tokens: skill.max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  const raw_html = stripMarkdownFences(raw_html_raw);

  logUsage(`html-skill:${slug}:${ticker}`, usage);

  const input_tokens  = usage?.prompt_tokens     ?? null;
  const output_tokens = usage?.completion_tokens  ?? null;
  const cost_usd      = usage?.cost               ?? null;

  const existing = await prisma.htmlSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null },
  });

  const output = existing
    ? await prisma.htmlSkillOutput.update({
        where: { id: existing.id },
        data: { raw_html, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, raw_html, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}

/**
 * Get or create the sentinel __preview__ HtmlSkill row used to anchor preview outputs.
 */
async function getPreviewSkill() {
  return prisma.htmlSkill.upsert({
    where:  { slug: PREVIEW_SKILL_SLUG },
    update: {},
    create: {
      slug:        PREVIEW_SKILL_SLUG,
      name:        'Preview (system)',
      skill_prompt: 'preview',
      transcript_signal_types:    [],
      ppt_signal_types:           [],
      annual_report_signal_types: [],
      category:    'management',
      is_active:   false,
    },
  });
}

/**
 * Compute a stable cache key for a preview run from its config inputs.
 */
function previewCacheKey({ ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_months }) {
  const payload = [
    ticker,
    model,
    String(max_tokens ?? ''),
    [...(transcript_signal_types ?? [])].sort().join(','),
    [...(ppt_signal_types ?? [])].sort().join(','),
    [...(annual_report_signal_types ?? [])].sort().join(','),
    String(max_transcript_qtrs ?? ''),
    String(max_ppt_qtrs ?? ''),
    String(max_annual_report_years ?? ''),
    String(market_data_months ?? ''),
    skill_prompt,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Run an unsaved HtmlSkill configuration against a ticker.
 * Saves output to html_skill_outputs under the __preview__ sentinel skill.
 * Does NOT create or modify any real HtmlSkill row.
 *
 * @param {object} opts
 * @param {string}   opts.ticker
 * @param {string}   opts.skill_prompt
 * @param {string[]} [opts.transcript_signal_types]
 * @param {string[]} [opts.ppt_signal_types]
 * @param {string[]} [opts.annual_report_signal_types]
 * @param {string}   opts.model
 * @param {number}   opts.max_tokens
 * @param {number|null} [opts.max_transcript_qtrs]
 * @param {number|null} [opts.max_ppt_qtrs]
 * @param {number|null} [opts.max_annual_report_years]
 * @param {number|null} [opts.market_data_months]  Include nse_equity_new P/E+CMP block for this many months (null = omit)
 * @param {boolean}  [opts.force]  Skip cache
 */
async function runHtmlSkillPreview({ ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_months = null, force = false }) {
  const previewSkill = await getPreviewSkill();
  const prompt_v     = previewCacheKey({ ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_months });

  if (!force) {
    const cached = await prisma.htmlSkillOutput.findFirst({
      where: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  const rawSignals = await querySignalsV2({ ticker });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs,
    max_ppt_qtrs,
    max_annual_report_years,
    transcript_signal_types:    transcript_signal_types    ?? [],
    ppt_signal_types:           ppt_signal_types           ?? [],
    annual_report_signal_types: annual_report_signal_types ?? [],
  });

  const dataBlock = buildDataBlock(signals);

  let marketDataBlock = '';
  if (market_data_months != null) {
    const marketData = await fetchNseMarketTimeseries(ticker, market_data_months);
    marketDataBlock = buildMarketDataBlock(marketData);
  }

  const systemPrompt = [
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\n');

  const { text: raw_html_raw, usage } = await llmStream({
    model,
    max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  const raw_html = stripMarkdownFences(raw_html_raw);

  logUsage(`html-skill-preview:${ticker}`, usage);

  const input_tokens  = usage?.prompt_tokens    ?? null;
  const output_tokens = usage?.completion_tokens ?? null;
  const cost_usd      = usage?.cost              ?? null;

  const existing = await prisma.htmlSkillOutput.findFirst({
    where: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null },
  });

  const output = existing
    ? await prisma.htmlSkillOutput.update({
        where: { id: existing.id },
        data:  { raw_html, prompt_v, model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null, raw_html, prompt_v, model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}

module.exports = { runHtmlSkill, runHtmlSkillPreview, buildHtmlSkillPrompt, applySignalLimits };
