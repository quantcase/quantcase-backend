'use strict';

const { createHash } = require('crypto');
const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');
const { FACT_VALIDATION_PROMPT, VISUAL_QA_PROMPT } = require('../prompts/validationPrompts');
const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');
const registerDashboardHelpers = require('../utils/handlebars-helpers');

registerDashboardHelpers(Handlebars);

Handlebars.registerHelper('lowercase', function (str) {
  return typeof str === 'string' ? str.toLowerCase() : '';
});
Handlebars.registerHelper('verified', function (val, options) {
  if (options && typeof options.fn === 'function') {
    return val ? options.fn(this) : options.inverse(this);
  }
  return val ? '✓' : '';
});
Handlebars.registerHelper('parseBold', function (text) {
  if (typeof text !== 'string') return text;
  const parsed = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  return new Handlebars.SafeString(parsed);
});
Handlebars.registerHelper('formatType', function (type) {
  if (typeof type !== 'string') return type;
  return type.replace(/_/g, '-');
});
Handlebars.registerHelper('effectColor', function (effect) {
  if (!effect) return 'var(--faint)';
  const e = effect.toLowerCase();
  if (e === 'positive') return 'var(--green)';
  if (e === 'negative') return 'var(--red)';
  if (e === 'neutral') return 'var(--amber)';
  return 'var(--faint)';
});
Handlebars.registerHelper('statusColor', function (status) {
  if (!status) return 'var(--faint)';
  const s = status.toLowerCase();
  if (s === 'achieved' || s === 'reaffirmed') return 'var(--green)';
  if (s === 'tracking' || s === 'unresolved') return 'var(--amber)';
  if (s === 'missed') return 'var(--red)';
  if (s === 'revised') return 'var(--qci-accent)';
  return 'var(--faint)';
});
Handlebars.registerHelper('eq', function (a, b) {
  return a === b;
});
Handlebars.registerHelper('pct', function (credible, total) {
  if (!total || total === 0) return 0;
  return Math.round((credible / total) * 100);
});
Handlebars.registerHelper('dashOffset', function (score) {
  score = Number(score) || 0;
  const radius = 30;
  const circumference = 2 * Math.PI * radius; // 188.5
  return circumference - (score / 100) * circumference;
});
Handlebars.registerHelper('scatterX', function (index, totalItems) {
  const chartWidth = 960; 
  const startX = 120;
  if (totalItems <= 1) return startX + (chartWidth / 2);
  const step = chartWidth / (totalItems - 1);
  return Math.round(startX + (index * step));
});
Handlebars.registerHelper('scatterY', function (credibility) {
  if (!credibility) return 115;
  const cred = credibility.toLowerCase();
  if (cred.includes('high')) return 70;
  if (cred.includes('mixed') || cred.includes('insufficient')) return 115;
  if (cred.includes('lower') || cred.includes('low')) return 155;
  return 115;
});
Handlebars.registerHelper('scatterR', function (confidence) {
  if (!confidence) return 4;
  const conf = confidence.toLowerCase();
  if (conf.includes('high')) return 10;
  if (conf.includes('moderate') || conf.includes('medium')) return 7;
  if (conf.includes('low')) return 4;
  return 7;
});
Handlebars.registerHelper('scatterColor', function (credibility) {
  if (!credibility) return 'var(--amber)';
  const cred = credibility.toLowerCase();
  if (cred.includes('high')) return 'var(--green)';
  if (cred.includes('mixed')) return 'var(--amber)';
  if (cred.includes('lower') || cred.includes('low')) return 'var(--red)';
  return 'var(--bg)'; // Insufficient
});
Handlebars.registerHelper('scatterLabelY', function (credibility) {
  if (!credibility) return 130;
  const cred = credibility.toLowerCase();
  if (cred.includes('high')) return 90;
  if (cred.includes('mixed') || cred.includes('insufficient')) return 135;
  if (cred.includes('lower') || cred.includes('low')) return 175;
  return 135;
});
Handlebars.registerHelper('credibilityLinePoints', function (timeline) {
  if (!timeline || !timeline.length) return '';
  const chartWidth = 960;
  const startX = 120;
  let step = 0;
  if (timeline.length > 1) step = chartWidth / (timeline.length - 1);
  
  return timeline.map((pt, i) => {
    let x = timeline.length <= 1 ? startX + (chartWidth / 2) : startX + (i * step);
    x = Math.round(x);
    let y = 115;
    if (pt.credibility) {
      const cred = pt.credibility.toLowerCase();
      if (cred.includes('high')) y = 70;
      else if (cred.includes('lower') || cred.includes('low')) y = 155;
    }
    return `${x},${y}`;
  }).join(' ');
});
Handlebars.registerHelper('sparkPoints', function(sparkArray, trend) {
  if (!sparkArray || !sparkArray.length) {
    if (trend === 'rising') return "0,35 20,25 40,30 60,15 80,20 100,5";
    if (trend === 'falling') return "0,5 20,15 40,10 60,25 80,20 100,35";
    return "0,23 20,25 40,20 60,28 80,15 100,23";
  }

  // New logic for array of arrays or objects
  if (Array.isArray(sparkArray[0]) || (sparkArray[0] && typeof sparkArray[0] === 'object')) {
    const safePoints = sparkArray
      .map((point) => {
        const x = Array.isArray(point) ? point[0] : point && point.x;
        const y = Array.isArray(point) ? point[1] : point && point.y;
        const safeX = Number(x);
        const safeY = Number(y);
        if (!Number.isFinite(safeX) || !Number.isFinite(safeY)) return null;
        return `${Math.max(0, Math.min(100, safeX))},${Math.max(0, Math.min(30, safeY))}`;
      })
      .filter(Boolean)
      .join(' ');
    return new Handlebars.SafeString(safePoints);
  }

  // Old logic for 1D arrays
  const min = Math.min(...sparkArray);
  const max = Math.max(...sparkArray);
  const range = max - min || 1;
  const stepX = 100 / (sparkArray.length - 1 || 1);
  return sparkArray.map((v, i) => {
    const x = Math.round(i * stepX);
    const y = Math.round(40 - ((v - min) / range) * 34); // Fit within 6-40
    return `${x},${y}`;
  }).join(' ');
});
Handlebars.registerHelper('sparkColor', function(trend) {
  if (trend === 'rising') return 'var(--qci-rising)';
  if (trend === 'falling') return 'var(--red-d)';
  if (trend === 'steady') return 'var(--qci-steady)';
  return 'var(--amber-d)';
});
Handlebars.registerHelper('sparkTerminalY', function(sparkArray, trend) {
  if (!sparkArray || !sparkArray.length) {
    if (trend === 'rising') return 5;
    if (trend === 'falling') return 35;
    return 23;
  }
  const min = Math.min(...sparkArray);
  const max = Math.max(...sparkArray);
  const range = max - min || 1;
  const lastVal = sparkArray[sparkArray.length - 1];
  return Math.round(40 - ((lastVal - min) / range) * 34);
});

const PREVIEW_SKILL_SLUG = '__preview__';

// ── nse_equity_new market data helpers ───────────────────────────────────────

async function fetchNsePeTimeseries(ticker, months) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT datetime AS date, pe::float AS value
    FROM   nse_equity_new
    WHERE  symbol   = $1
      AND  pe       IS NOT NULL
      AND  datetime >= NOW() - ($2 || ' months')::INTERVAL
    ORDER  BY datetime ASC
  `, ticker, String(months));

  if (!rows || rows.length === 0) return null;

  const series = rows.map(r => ({
    date:  (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10),
    value: r.value != null ? parseFloat(r.value.toFixed(2)) : null,
  }));
  return { latest: series.at(-1), series };
}

async function fetchNseCmpTimeseries(ticker, months) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT datetime AS date, close::float AS value
    FROM   nse_equity_new
    WHERE  symbol   = $1
      AND  close    IS NOT NULL
      AND  datetime >= NOW() - ($2 || ' months')::INTERVAL
    ORDER  BY datetime ASC
  `, ticker, String(months));

  if (!rows || rows.length === 0) return null;

  const series = rows.map(r => ({
    date:  (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10),
    value: r.value != null ? parseFloat(r.value.toFixed(2)) : null,
  }));
  return { latest: series.at(-1), series };
}

function buildMetricBlock(label, unit, data) {
  if (!data) return '';
  const lines = [
    `${label} (${unit}) — latest: ${data.latest?.value ?? 'N/A'} as_of ${data.latest?.date ?? 'N/A'}`,
    'date\tvalue',
  ];
  for (const r of data.series) lines.push(`${r.date}\t${r.value ?? ''}`);
  return lines.join('\n');
}

/**
 * Assemble the full MARKET DATA block from independently-fetched pe/cmp series.
 * Either series may be null (not configured for this skill).
 */
function buildMarketDataBlock(peData, cmpData) {
  const sections = [];
  if (peData)  sections.push(buildMetricBlock('P/E RATIO', 'x',  peData));
  if (cmpData) sections.push(buildMetricBlock('CMP',       '₹', cmpData));
  if (!sections.length) return '';

  return [
    '',
    '--- MARKET DATA (nse_equity_new) ---',
    sections.join('\n\n'),
    '--- END MARKET DATA ---',
  ].join('\n');
}

function stripMarkdownFences(text) {
  if (!text) return '';
  let clean = text;
  const match = clean.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (match) {
    clean = match[1];
  } else {
    clean = clean.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/i, '');
  }
  
  clean = clean.trim().replace(/^(json|html)\s*(?=[<{\[])/i, '');
  
  return clean.trim();
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

  const mdTypes = new Set(skill.market_data_signal_types ?? []);
  const mdMonths = skill.max_market_data_months;
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && mdMonths != null) ? fetchNsePeTimeseries(ticker,  mdMonths) : null,
    (mdTypes.has('cmp') && mdMonths != null) ? fetchNseCmpTimeseries(ticker, mdMonths) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

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
}, job) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlSkill is inactive: ${slug}`), { status: 400 });

  const prompt_v = `${slug}@${skill.updated_at.toISOString()}`;

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

  const mdTypes = new Set(skill.market_data_signal_types ?? []);
  const mdMonths = skill.max_market_data_months;
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && mdMonths != null) ? fetchNsePeTimeseries(ticker,  mdMonths) : null,
    (mdTypes.has('cmp') && mdMonths != null) ? fetchNseCmpTimeseries(ticker, mdMonths) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

  const { raw_html, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker, extraction_model: skill.extraction_model, fact_validation_model: skill.fact_validation_model, html_template_model: skill.html_template_model, visual_qa_model: skill.visual_qa_model, max_tokens: skill.max_tokens,
    data_extraction_prompt: skill.data_extraction_prompt,
    html_template_prompt: skill.html_template_prompt,
    html_template_filename: skill.html_template_filename,
    use_template_engine: skill.use_template_engine,
    enable_data_validation: skill.enable_data_validation,
    data_validation_loops: skill.data_validation_loops,
    enable_html_validation: skill.enable_html_validation,
    expected_json_schema: skill.expected_json_schema,
    json_validation_prompt: skill.json_validation_prompt,
    dataBlock, marketDataBlock, job
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
        data: { raw_html, extracted_json, audit_logs, prompt_v, model: skill.extraction_model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, raw_html, extracted_json, audit_logs, prompt_v, model: skill.extraction_model, input_tokens, output_tokens, cost_usd },
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
function previewCacheKey({ ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_signal_types, max_market_data_months }) {
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
    [...(market_data_signal_types ?? [])].sort().join(','),
    String(max_market_data_months ?? ''),
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
 * @param {string[]} [opts.market_data_signal_types]  Which market metrics to include ("pe", "cmp")
 * @param {number|null} [opts.market_pe_months]        Months of P/E history (requires "pe" in signal types)
 * @param {number|null} [opts.market_cmp_months]       Months of CMP history (requires "cmp" in signal types)
 * @param {boolean}  [opts.force]  Skip cache
 */
async function runHtmlSkillPreview({ ticker, data_extraction_prompt, html_template_prompt, use_template_engine, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types, ppt_signal_types, annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_signal_types = [], max_market_data_months = null, force = false, expected_json_schema, json_validation_prompt }, job) {
  const previewSkill = await getPreviewSkill();
  
  // NOTE: previewCacheKey should ideally use all these fields but it's preview so we can just generate a random v for force or include them.
  const prompt_v = Date.now().toString();

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

  const mdTypes = new Set(market_data_signal_types ?? []);
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && max_market_data_months != null) ? fetchNsePeTimeseries(ticker,  max_market_data_months) : null,
    (mdTypes.has('cmp') && max_market_data_months != null) ? fetchNseCmpTimeseries(ticker, max_market_data_months) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

  const { raw_html, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens,
    data_extraction_prompt, html_template_prompt, html_template_filename,
    use_template_engine, enable_data_validation, data_validation_loops, enable_html_validation,
    dataBlock, marketDataBlock, job, expected_json_schema, json_validation_prompt
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
        data:  { raw_html, extracted_json, audit_logs, prompt_v, model: extraction_model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null, raw_html, extracted_json, audit_logs, prompt_v, model: extraction_model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}

module.exports = {
  runAgenticPipeline,
  runHtmlSkill,
  runHtmlSkillPreview,
  buildHtmlSkillPrompt,
  applySignalLimits,
  buildDataBlock,
  stripMarkdownFences,
  fetchNsePeTimeseries,
  fetchNseCmpTimeseries,
  buildMarketDataBlock,
};


async function runAgenticPipeline({
  ticker, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens, data_extraction_prompt, html_template_prompt, html_template_filename,
  use_template_engine, enable_data_validation, data_validation_loops, enable_html_validation,
  expected_json_schema, json_validation_prompt,
  dataBlock, marketDataBlock, job, pre_extracted_json
}) {
  const audit_logs = { fact_validation: [], visual_qa: [] };
  let extracted_json = pre_extracted_json || null;
  let raw_html = null;
  let usageAcc = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };

  const mergeUsage = (u) => {
    if (u) {
      usageAcc.prompt_tokens += (u.prompt_tokens || 0);
      usageAcc.completion_tokens += (u.completion_tokens || 0);
      usageAcc.cost += (u.cost || 0);
    }
  };

  const notifyProgress = async (percent, stage) => {
    if (job) await job.updateProgress(percent);
  };
  const logJob = async (msg) => {
    if (job) await job.log(msg);
  };

  if (!extracted_json) {
    // Phase 1: Data Extraction
    await notifyProgress(20, 'extracting_data');
    await logJob(`[Phase 1] Extracting data...`);
  
  let jsonString = '';
  let jsonParseSuccess = false;
  let parseAttempts = 0;
  
  // Format Validation Loop (JSON)
  let currentExtractionPrompt = [
    data_extraction_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\n');

  while (!jsonParseSuccess && parseAttempts < 3) {
    const { text, usage } = await llmStream({
      model: extraction_model, max_tokens,
        messages: [
        { role: 'system', content: 'You are an expert data extraction agent. Output ONLY raw JSON.' },
        { role: 'user', content: currentExtractionPrompt }
      ],
      // reasoning can be handled by OpenRouter if supported by model string, we assume the model inherits it
    }, { vertex: true });
    mergeUsage(usage);
    jsonString = stripMarkdownFences(text);
    try {
      extracted_json = JSON.parse(jsonString);
      jsonParseSuccess = true;
      await logJob(`[Phase 1] JSON extraction successful.`);
    } catch (e) {
      parseAttempts++;
      await logJob(`[Phase 1] JSON parse error: ${e.message}. Retrying (${parseAttempts}/3)...`);
      currentExtractionPrompt = `You previously generated invalid JSON. Fix the syntax error and return ONLY valid JSON.\n\nError: ${e.message}\n\nInvalid Output:\n${jsonString}`;
    }
  }
  
  if (!jsonParseSuccess) throw new Error("Failed to generate valid JSON after 3 attempts.");

  // Feedback Loop 1: Fact Validation
  const shouldValidateData = enable_data_validation === true || enable_data_validation === 'true' || enable_data_validation === 1 || enable_data_validation === '1';
  if (shouldValidateData) {
    await notifyProgress(40, 'validating_facts');
    let validationLoops = data_validation_loops ?? 1;
    for (let i = 0; i < validationLoops; i++) {
      await logJob(`[Loop 1] Running fact validation (Pass ${i+1}/${validationLoops})...`);
      const { text, usage } = await llmStream({
        model: fact_validation_model, max_tokens,
        messages: [
          { role: 'system', content: FACT_VALIDATION_PROMPT },
          { role: 'user', content: `--- ORIGINAL DATA ---\n${dataBlock}\n\n--- EXTRACTED JSON ---\n${JSON.stringify(extracted_json, null, 2)}` }
        ]
      }, { vertex: true });
      mergeUsage(usage);
      const critiqueStr = stripMarkdownFences(text);
      let critique = [];
      try { critique = JSON.parse(critiqueStr); } catch(e) { critique = [critiqueStr]; }
      
      if (!Array.isArray(critique)) critique = [critique];
      
      audit_logs.fact_validation.push(critique);
      
      if (critique.length === 0) {
        await logJob(`[Loop 1] No hallucinations found.`);
        break; // Passed
      }
      
      await logJob(`[Loop 1] Found errors: ${JSON.stringify(critique)}. Correcting JSON...`);
      
      // Correction Pass
      const { text: correctedText, usage: cUsage } = await llmStream({
        model: fact_validation_model, max_tokens,
        messages: [
          { role: 'system', content: 'You are a data correction agent. Update the JSON based on the critique and return ONLY valid JSON.' },
          { role: 'user', content: `--- CRITIQUE ---\n${JSON.stringify(critique)}\n\n--- CURRENT JSON ---\n${JSON.stringify(extracted_json, null, 2)}` }
        ]
      }, { vertex: true });
      mergeUsage(cUsage);
      const correctedJsonStr = stripMarkdownFences(correctedText);
      try {
        extracted_json = JSON.parse(correctedJsonStr);
      } catch(e) {
        await logJob(`[Loop 1] Failed to parse corrected JSON, sticking with previous version.`);
      }
    }
  }
  }

  // Phase 2: HTML Generation
  await notifyProgress(60, 'rendering_html');
  await logJob(`[Phase 2] Rendering HTML template...`);
  
  if (use_template_engine) {
    try {
      let templateStr = html_template_prompt;
      if (html_template_filename) {
        const tplPath = path.join(__dirname, '..', 'templates', html_template_filename);
        if (fs.existsSync(tplPath)) {
          templateStr = fs.readFileSync(tplPath, 'utf8');
        } else {
          await logJob(`[Phase 2] Template file not found: ${html_template_filename}. Falling back to prompt box.`);
        }
      }
      const template = Handlebars.compile(templateStr);
      raw_html = template(extracted_json);
      await logJob(`[Phase 2] HTML rendering successful via Handlebars.`);
    } catch (err) {
      await logJob(`[Phase 2] Handlebars rendering failed: ${err.message}`);
      throw new Error(`Failed to render HTML template using Handlebars: ${err.message}`);
    }
  } else {
    let htmlRenderSuccess = false;
    let htmlAttempts = 0;
    let currentHtmlPrompt = [
      html_template_prompt,
      '',
      '--- VALIDATED JSON DATA ---',
      JSON.stringify(extracted_json, null, 2),
      '--- END JSON DATA ---',
    ].join('\n');

    while (!htmlRenderSuccess && htmlAttempts < 3) {
      const { text, usage } = await llmStream({
        model: html_template_model, max_tokens,
          messages: [
          { role: 'system', content: 'Return ONLY a complete, standalone HTML file. No markdown. No explanation.' },
          { role: 'user', content: currentHtmlPrompt }
        ]
      }, { vertex: true });
      mergeUsage(usage);
      raw_html = stripMarkdownFences(text);
      
      if (raw_html.toLowerCase().includes('<html') || raw_html.toLowerCase().includes('<div') || raw_html.toLowerCase().includes('<style')) {
        htmlRenderSuccess = true;
        await logJob(`[Phase 2] HTML rendering successful.`);
      } else {
        htmlAttempts++;
        await logJob(`[Phase 2] Missing HTML structure. Retrying (${htmlAttempts}/3)...`);
        currentHtmlPrompt = `You did not output valid HTML code. Return ONLY raw HTML.\n\nInvalid Output:\n${raw_html}`;
      }
    }
    
    if (!htmlRenderSuccess) throw new Error("Failed to generate valid HTML structure after 3 attempts.");
  }

  // Feedback Loop 2: JSON Schema Validation & Narrative Synthesis
  const shouldValidateSchema = enable_html_validation === true || enable_html_validation === 'true' || enable_html_validation === 1 || enable_html_validation === '1';

  if (shouldValidateSchema && expected_json_schema) {
    let expectedSchema = null;
    try {
      expectedSchema = typeof expected_json_schema === 'string' ? JSON.parse(expected_json_schema) : expected_json_schema;
    } catch (e) {
      await logJob(`[Loop 2] Failed to parse expected_json_schema from DB.`);
    }
    
    if (expectedSchema) {
      let schemaAttempts = 0;
      let missingFields = getMissingFields(expectedSchema, extracted_json);

      while (missingFields.length > 0 && schemaAttempts < 5) {
        schemaAttempts++;
        await logJob(`[Loop 2] Missing schema fields detected: ${missingFields.join(', ')}. Regenerating narratives (Attempt ${schemaAttempts}/5)...`);

        const SYSTEM_PROMPT = json_validation_prompt || `You are a strict JSON schema validator and expert financial analyst. 
Your task is to regenerate ONLY the specific fields listed in the MISSING FIELDS array.

1. Analyze the ORIGINAL DATA to synthesize the missing narratives (insights, verdicts, headlines). Use the EXTRACTION RULES for context on how these fields should be formatted and calculated (e.g. scoring out of 100).
2. Adhere STRICTLY to the data types defined in the EXPECTED SCHEMA (e.g., if it says "string", output a primitive string, not a nested object).
3. Output ONLY a partial JSON object containing the newly generated fields. Do NOT output the entire JSON. Do NOT wrap in markdown fences.`;

        const USER_PROMPT = `
--- MISSING FIELDS TO GENERATE ---
${JSON.stringify(missingFields)}

--- EXPECTED SCHEMA (FOR TYPE REFERENCE) ---
${JSON.stringify(expectedSchema, null, 2)}

--- EXTRACTION RULES (FOR CONTEXT) ---
${data_extraction_prompt}

--- ORIGINAL DATA ---
${dataBlock}
`;

        const { text: newJsonStr, usage } = await llmStream({
          model: fact_validation_model || visual_qa_model, 
          max_tokens,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: USER_PROMPT }
          ]
        }, { vertex: true });
        
        mergeUsage(usage);

        try {
          const parsed = JSON.parse(stripMarkdownFences(newJsonStr));
          audit_logs.visual_qa.push({
            attempt: schemaAttempts,
            missing_fields: missingFields,
            patch: parsed
          });
          extracted_json = deepMerge(extracted_json, parsed); 
          missingFields = getMissingFields(expectedSchema, extracted_json); 
        } catch(e) {
          await logJob(`[Loop 2] Failed to parse regenerated JSON: ${e.message}`);
        }
      }
      
      if (missingFields.length === 0) {
        await logJob(`[Loop 2] JSON perfectly matches expected schema.`);
      } else {
        await logJob(`[Loop 2] Warning: JSON still missing fields after 5 attempts: ${missingFields.join(', ')}`);
      }
      
      // Update HTML with the synthesized JSON
      if (use_template_engine && html_template_filename) {
         try {
            const tplPath = require('path').join(__dirname, '..', 'templates', html_template_filename);
            if (require('fs').existsSync(tplPath)) {
               const templateStr = require('fs').readFileSync(tplPath, 'utf8');
               const Handlebars = require('handlebars');
               const template = Handlebars.compile(templateStr);
               raw_html = template(extracted_json);
               await logJob(`[Loop 2] HTML successfully re-rendered with synthesized JSON.`);
            }
         } catch(e) {
            await logJob(`[Loop 2] HTML re-render failed: ${e.message}`);
         }
      }
    }
  }

  if (typeof raw_html === 'string') {
    // Automatically parse **markdown** bold tags into <strong> HTML elements globally
    raw_html = raw_html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
  }

  return { raw_html, extracted_json, audit_logs, usage: usageAcc };
}

function getMissingFields(expected, actual, path = '') {
  let missing = [];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      missing.push(path || 'root_array');
    } else if (expected.length > 0) {
      if (actual.length === 0) {
        // Array is empty but we expected items. Flag as missing so LLM attempts to synthesize it.
        missing.push(path);
      } else {
        // Validate every item in the actual array against the expected schema
        actual.forEach((actItem, idx) => {
          missing.push(...getMissingFields(expected[0], actItem, path ? `${path}[${idx}]` : `[${idx}]`));
        });
      }
    }
  } else if (expected !== null && typeof expected === 'object') {
    if (Object.keys(expected).length === 0) {
      // Untyped placeholder {} in schema. Accept any value that exists and is not an empty object itself.
      if (actual === undefined || actual === null || actual === '' || (typeof actual === 'object' && Object.keys(actual).length === 0)) {
        missing.push(path);
      }
    } else if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      missing.push(path || 'root_object');
    } else {
      for (const key in expected) {
        missing.push(...getMissingFields(expected[key], actual[key], path ? `${path}.${key}` : key));
      }
    }
  } else {
    // Type checking for primitives
    if (actual === undefined || actual === null || actual === '') {
      missing.push(path);
    } else {
      // If expected is a primitive string placeholder like "string", "number", etc.
      if (typeof expected === 'string') {
        if (typeof actual === 'object' || Array.isArray(actual)) {
          // It's an object/array but we expect a primitive (This causes the [object Object] bug)
          missing.push(path);
        }
      }
    }
  }
  return missing;
}


function deepMerge(target, source) {
  if (source === undefined) return target;
  if (typeof target !== 'object' || target === null) return source;
  if (typeof source !== 'object' || source === null) return source;

  if (Array.isArray(target) && !Array.isArray(source)) {
    // Sometimes the LLM returns an object {"2": {...}} to patch the 3rd item of an array
    const isNumericalObject = Object.keys(source).every(k => !isNaN(parseInt(k, 10)));
    if (isNumericalObject) {
      const result = [...target];
      for (const key of Object.keys(source)) {
        const idx = parseInt(key, 10);
        if (idx < result.length) {
          result[idx] = deepMerge(result[idx], source[key]);
        } else {
          result[idx] = source[key];
        }
      }
      return result;
    }
  }

  if (Array.isArray(target) !== Array.isArray(source)) {
    return source;
  }

  if (Array.isArray(target) && Array.isArray(source)) {
    const result = [...target];
    source.forEach((item, index) => {
      if (item !== null && item !== undefined) {
        if (index < result.length) {
          result[index] = deepMerge(result[index], item);
        } else {
          result.push(item);
        }
      }
    });
    return result;
  }

  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && target[key]) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  Object.assign(target || {}, source);
  return target;
}
