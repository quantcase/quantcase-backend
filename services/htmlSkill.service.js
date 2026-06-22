'use strict';

const { createHash } = require('crypto');
const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');

const PREVIEW_SKILL_SLUG = '__preview__';

/**
 * Trim signals to respect per-source-type window limits from the skill config.
 * Signals are already ordered by call_date desc, so we just collect the N most
 * recent distinct period keys per source bucket.
 *
 * A limit of 0 means "include none"; null/undefined means "no limit".
 *
 * @param {object[]} signals  Shaped V2 signals ordered by call_date desc
 * @param {object}   limits
 * @param {number|null} limits.max_transcript_qtrs      Max distinct (fiscal_year, quarter) combos for transcript
 * @param {number|null} limits.max_ppt_qtrs             Max distinct (fiscal_year, quarter) combos for ppt
 * @param {number|null} limits.max_annual_report_years  Max distinct fiscal_year values for annual_report
 */
function applySignalLimits(signals, { max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years }) {
  const hasLimit = v => v != null;
  if (!hasLimit(max_transcript_qtrs) && !hasLimit(max_ppt_qtrs) && !hasLimit(max_annual_report_years)) return signals;

  const transcriptAllowed = new Set();
  const pptAllowed        = new Set();
  const annualAllowed     = new Set();
  const transcriptLimit   = max_transcript_qtrs     ?? Infinity;
  const pptLimit          = max_ppt_qtrs            ?? Infinity;
  const annualLimit       = max_annual_report_years  ?? Infinity;

  // First pass: collect the allowed period keys in recency order
  for (const s of signals) {
    const docType = s.source_doc_type;
    if (docType === 'annual_report') {
      if (annualAllowed.size < annualLimit) annualAllowed.add(s.fiscal_year);
    } else if (docType === 'ppt') {
      const key = `${s.fiscal_year}|${s.quarter}`;
      if (pptAllowed.size < pptLimit) pptAllowed.add(key);
    } else {
      // transcript (and any unrecognised doc type)
      const key = `${s.fiscal_year}|${s.quarter}`;
      if (transcriptAllowed.size < transcriptLimit) transcriptAllowed.add(key);
    }
  }

  // Second pass: keep only signals whose period key is in the allowed set
  return signals.filter(s => {
    const docType = s.source_doc_type;
    if (docType === 'annual_report') return annualAllowed.has(s.fiscal_year);
    if (docType === 'ppt')           return pptAllowed.has(`${s.fiscal_year}|${s.quarter}`);
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
async function buildHtmlSkillPrompt({ slug, ticker }) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });

  const rawSignals = await querySignalsV2({ ticker, signal_types: skill.signal_types });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs:     skill.max_transcript_qtrs,
    max_ppt_qtrs:            skill.max_ppt_qtrs,
    max_annual_report_years: skill.max_annual_report_years,
  });
  const dataBlock = buildDataBlock(signals);

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
async function runHtmlSkill({ slug, ticker, fiscal_year, quarter, force = false }) {
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

  // Fetch V2 signals filtered by this skill's signal_types, then apply window limits
  const rawSignals = await querySignalsV2({ ticker, signal_types: skill.signal_types });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs:     skill.max_transcript_qtrs,
    max_ppt_qtrs:            skill.max_ppt_qtrs,
    max_annual_report_years: skill.max_annual_report_years,
  });

  const dataBlock = buildDataBlock(signals);

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
  ].join('\n');

  const { text: raw_html, usage } = await llmStream({
    model:      skill.model,
    max_tokens: skill.max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });

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
      signal_types: [],
      category:    'management',
      is_active:   false,
    },
  });
}

/**
 * Compute a stable cache key for a preview run from its config inputs.
 */
function previewCacheKey({ ticker, skill_prompt, signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years }) {
  const payload = [
    ticker,
    model,
    String(max_tokens ?? ''),
    [...(signal_types ?? [])].sort().join(','),
    String(max_transcript_qtrs ?? ''),
    String(max_ppt_qtrs ?? ''),
    String(max_annual_report_years ?? ''),
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
 * @param {string[]} opts.signal_types
 * @param {string}   opts.model
 * @param {number}   opts.max_tokens
 * @param {number|null} [opts.max_transcript_qtrs]
 * @param {number|null} [opts.max_ppt_qtrs]
 * @param {number|null} [opts.max_annual_report_years]
 * @param {boolean}  [opts.force]  Skip cache
 */
async function runHtmlSkillPreview({ ticker, skill_prompt, signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, force = false }) {
  const previewSkill = await getPreviewSkill();
  const prompt_v     = previewCacheKey({ ticker, skill_prompt, signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years });

  if (!force) {
    const cached = await prisma.htmlSkillOutput.findFirst({
      where: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  const rawSignals = await querySignalsV2({ ticker, signal_types: signal_types ?? [] });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs,
    max_ppt_qtrs,
    max_annual_report_years,
  });

  const dataBlock = buildDataBlock(signals);

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
  ].join('\n');

  const { text: raw_html, usage } = await llmStream({
    model,
    max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });

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
