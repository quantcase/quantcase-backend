'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { addHtmlSkillJob, addHtmlSkillPreviewJob } = require('../services/jobs.service');
const { buildHtmlSkillPrompt, applySignalLimits } = require('../services/htmlSkill.service');

const VALID_TRANSCRIPT_SIGNAL_TYPES = new Set([
  'guidance','industry_signal','capital_allocation','disclosure_quality',
  'distribution_customer','growth_forecast','earnings_quality','kpi',
  'mgmt_tone','analyst_questions','guidance_revision','pricing_power',
  'competitive_position','milestone','ongoing',
]);

const VALID_PPT_SIGNAL_TYPES = new Set([
  'guidance','industry_signal','capital_allocation','disclosure_quality',
  'distribution_customer','growth_forecast','earnings_quality','kpi',
  'mgmt_tone','analyst_questions','guidance_revision','pricing_power',
  'competitive_position','milestone','ongoing',
]);

const VALID_ANNUAL_REPORT_SIGNAL_TYPES = new Set([
  'financial_figure','notes_to_accounts','guidance','growth_forecast',
  'capital_allocation','risk_factor','contingent_liability','governance_signal',
  'strategic_claim','m_and_a','kpi','leadership_statement','milestone','ongoing',
  'industry_signal','disclosure_quality','earnings_quality','guidance_revision',
]);

// Combined set for the /signals/count endpoint (covers all doc types)
const ALL_VALID_SIGNAL_TYPES = new Set([
  ...VALID_TRANSCRIPT_SIGNAL_TYPES,
  ...VALID_PPT_SIGNAL_TYPES,
  ...VALID_ANNUAL_REPORT_SIGNAL_TYPES,
]);

const router = Router();

const SKILL_ORDER = [
  'guidance-credibility',
  'capital-allocation',
  'disclosure-honesty',
  'promoter-activity',
  'industry-analysis',
  'financial-strength',
  'customer-distribution',
  'competition',
  'earning-quality',
  'earnings-forecast',
  'pe-rerating-potential',
  'target-price-matrix',
];

function sortSkills(skills) {
  return [...skills].sort((a, b) => {
    const ai = SKILL_ORDER.indexOf(a.slug);
    const bi = SKILL_ORDER.indexOf(b.slug);
    if (ai === -1 && bi === -1) return a.slug.localeCompare(b.slug);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// GET /api/html-skills — list all skills
router.get('/', async (req, res, next) => {
  try {
    const { includeInactive } = req.query;
    const skills = await prisma.htmlSkill.findMany({
      where:  includeInactive === 'true' ? {} : { is_active: true },
      select: { id: true, slug: true, name: true, category: true, transcript_signal_types: true, ppt_signal_types: true, annual_report_signal_types: true, model: true, max_tokens: true, max_transcript_qtrs: true, max_ppt_qtrs: true, max_annual_report_years: true, is_active: true, created_at: true, updated_at: true },
    });
    res.json({ count: skills.length, skills: sortSkills(skills) });
  } catch (err) {
    next(err);
  }
});

// POST /api/html-skills/run-preview — enqueue a one-off skill run using unsaved config
// Body: { ticker, skill_prompt, transcript_signal_types?, ppt_signal_types?, annual_report_signal_types?,
//         model, max_tokens, max_transcript_qtrs?, max_ppt_qtrs?, max_annual_report_years?, force? }
router.post('/run-preview', async (req, res, next) => {
  try {
    const {
      ticker, skill_prompt,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, force,
    } = req.body;

    if (!ticker)       return res.status(400).json({ error: 'ticker is required' });
    if (!skill_prompt) return res.status(400).json({ error: 'skill_prompt is required' });
    if (!model)        return res.status(400).json({ error: 'model is required' });
    if (!max_tokens)   return res.status(400).json({ error: 'max_tokens is required' });

    const job = await addHtmlSkillPreviewJob({
      ticker,
      skill_prompt,
      transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : [],
      ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : [],
      annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : [],
      model,
      max_tokens,
      max_transcript_qtrs:     max_transcript_qtrs     ?? null,
      max_ppt_qtrs:            max_ppt_qtrs            ?? null,
      max_annual_report_years: max_annual_report_years ?? null,
      force: force === true,
    });

    res.json({ success: true, message: 'Job queued', job: { id: job.id, type: 'html-skill-preview', status: 'pending' } });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-skills/:slug — get one skill with full prompt
router.get('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlSkill.findUnique({ where: { slug: req.params.slug } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  } catch (err) {
    next(err);
  }
});

// POST /api/html-skills — create a skill
router.post('/', async (req, res, next) => {
  try {
    const { slug, name, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, category, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, is_active } = req.body;
    if (!slug || !name || !skill_prompt || !category) {
      return res.status(400).json({ error: 'slug, name, skill_prompt, and category are required' });
    }
    const skill = await prisma.htmlSkill.create({
      data: {
        slug, name, skill_prompt, category,
        transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : [],
        ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : [],
        annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : [],
        ...(model                   != null && { model }),
        ...(max_tokens              != null && { max_tokens }),
        ...(max_transcript_qtrs     != null && { max_transcript_qtrs }),
        ...(max_ppt_qtrs            != null && { max_ppt_qtrs }),
        ...(max_annual_report_years != null && { max_annual_report_years }),
        ...(is_active               != null && { is_active }),
      },
    });
    res.status(201).json(skill);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Skill with slug "${req.body.slug}" already exists` });
    next(err);
  }
});

// PUT /api/html-skills/:slug — update a skill
router.put('/:slug', async (req, res, next) => {
  try {
    const allowed = ['name', 'skill_prompt', 'transcript_signal_types', 'ppt_signal_types', 'annual_report_signal_types', 'category', 'model', 'max_tokens', 'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years', 'is_active'];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const skill = await prisma.htmlSkill.update({
      where: { slug: req.params.slug },
      data,
    });
    res.json(skill);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

// DELETE /api/html-skills/:slug — soft delete (set is_active = false)
router.delete('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlSkill.update({
      where: { slug: req.params.slug },
      data:  { is_active: false },
    });
    res.json({ success: true, slug: skill.slug, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

// GET /api/html-skills/signals/count/:ticker
// Returns per-source-doc-type signal counts for a ticker.
// Optional query params:
//   max_transcript_qtrs          — integer, limit to N most recent (fiscal_year, quarter) combos for transcript
//   max_ppt_qtrs                 — integer, limit to N most recent (fiscal_year, quarter) combos for ppt
//   max_annual_report_years      — integer, limit to N most recent fiscal years for annual_report
//   transcript_signal_types      — comma-separated, filter by signal type for transcript
//   ppt_signal_types             — comma-separated, filter by signal type for ppt
//   annual_report_signal_types   — comma-separated, filter by signal type for annual_report
router.get('/signals/count/:ticker', async (req, res, next) => {
  try {
    const { ticker } = req.params;
    const { max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, transcript_signal_types, ppt_signal_types, annual_report_signal_types } = req.query;

    const parseLimit = v => (v != null ? parseInt(v, 10) : null);
    const parseTypes = v => (v ? decodeURIComponent(v).split(',').map(s => s.trim()).filter(Boolean) : null);
    const limits = {
      max_transcript_qtrs:        parseLimit(max_transcript_qtrs),
      max_ppt_qtrs:               parseLimit(max_ppt_qtrs),
      max_annual_report_years:    parseLimit(max_annual_report_years),
      transcript_signal_types:    parseTypes(transcript_signal_types),
      ppt_signal_types:           parseTypes(ppt_signal_types),
      annual_report_signal_types: parseTypes(annual_report_signal_types),
    };
    const hasLimits = Object.values(limits).some(v => v != null);

    // Always fetch per-row so we can segregate by source_doc_type
    const rows = await prisma.transcriptSignalV2.findMany({
      where:   { ticker, is_invalidated: false },
      select:  { signal_type: true, fiscal_year: true, quarter: true, source_doc_type: true, call_date: true },
      orderBy: [{ call_date: 'desc' }],
    });

    const filtered = hasLimits ? applySignalLimits(rows, limits) : rows;

    // Build per-source buckets
    const sources = { transcript: {}, ppt: {}, annual_report: {} };
    const transcriptPeriods = new Set();
    const pptPeriods        = new Set();
    const annualPeriods     = new Set();

    for (const s of filtered) {
      const docType = s.source_doc_type ?? 'transcript';
      const bucket  = sources[docType] ?? (sources[docType] = {});
      bucket[s.signal_type] = (bucket[s.signal_type] ?? 0) + 1;

      if (docType === 'annual_report') {
        annualPeriods.add(s.fiscal_year);
      } else if (docType === 'ppt') {
        pptPeriods.add(`${s.fiscal_year}|${s.quarter}`);
      } else {
        transcriptPeriods.add(`${s.fiscal_year}|${s.quarter}`);
      }
    }

    const toSignalCounts = bucket =>
      Object.entries(bucket)
        .map(([signal_type, count]) => ({ signal_type, count }))
        .sort((a, b) => a.signal_type.localeCompare(b.signal_type));

    const toQtrPeriods = set =>
      [...set].map(k => { const [fiscal_year, quarter] = k.split('|'); return { fiscal_year, quarter }; });

    const toYearPeriods = set =>
      [...set].map(fiscal_year => ({ fiscal_year }));

    const transcriptCounts = toSignalCounts(sources.transcript);
    const pptCounts        = toSignalCounts(sources.ppt);
    const annualCounts     = toSignalCounts(sources.annual_report);

    res.json({
      ticker,
      total: filtered.length,
      by_source: {
        transcript: {
          total:         transcriptCounts.reduce((s, r) => s + r.count, 0),
          periods_count: transcriptPeriods.size,
          periods:       toQtrPeriods(transcriptPeriods),
          signal_counts: transcriptCounts,
        },
        ppt: {
          total:         pptCounts.reduce((s, r) => s + r.count, 0),
          periods_count: pptPeriods.size,
          periods:       toQtrPeriods(pptPeriods),
          signal_counts: pptCounts,
        },
        annual_report: {
          total:         annualCounts.reduce((s, r) => s + r.count, 0),
          periods_count: annualPeriods.size,
          periods:       toYearPeriods(annualPeriods),
          signal_counts: annualCounts,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-skills/:slug/signals/:ticker
// Returns the exact signals that would be sent to the LLM when running this skill,
// with all signal-content fields included.
router.get('/:slug/signals/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;

    const skill = await prisma.htmlSkill.findUnique({ where: { slug }, select: { id: true, transcript_signal_types: true, ppt_signal_types: true, annual_report_signal_types: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    // Combine all signal types across source types for the initial fetch;
    // per-source filtering is applied in applySignalLimits during skill execution
    const allSkillTypes = [
      ...skill.transcript_signal_types,
      ...skill.ppt_signal_types,
      ...skill.annual_report_signal_types,
    ];
    const where = { ticker, is_invalidated: false };
    if (allSkillTypes.length > 0) where.signal_type = { in: allSkillTypes };

    const rows = await prisma.transcriptSignalV2.findMany({
      where,
      orderBy: [{ call_date: 'desc' }, { created_at: 'desc' }],
    });

    const signals = rows.map(r => ({
      id:              r.id,
      call_id:         r.call_id,
      ticker:          r.ticker,
      company:         r.company,
      fiscal_year:     r.fiscal_year,
      quarter:         r.quarter,
      call_date:       r.call_date,
      signal_type:     r.signal_type,
      metric:          r.metric,
      impact:          r.impact,
      severity:        r.severity,
      statement:       r.statement,
      source_doc_type: r.source_doc_type,
      source_context:  r.source_context,
      data:            r.data,
    }));

    res.json({ ticker, slug, total: signals.length, signals });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-skills/:slug/prompt/:ticker — dry-run: return assembled prompt without calling LLM
// Optional query params: max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
//   transcript_signal_types (comma-separated), ppt_signal_types, annual_report_signal_types
router.get('/:slug/prompt/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const parseLimit = v => (v != null ? parseInt(v, 10) : null);
    const parseTypes = v => (v ? decodeURIComponent(v).split(',').map(s => s.trim()).filter(Boolean) : null);
    const {
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
    } = req.query;
    const { systemPrompt, userPrompt, signal_count } = await buildHtmlSkillPrompt({
      slug, ticker,
      max_transcript_qtrs:        parseLimit(max_transcript_qtrs),
      max_ppt_qtrs:               parseLimit(max_ppt_qtrs),
      max_annual_report_years:    parseLimit(max_annual_report_years),
      transcript_signal_types:    parseTypes(transcript_signal_types),
      ppt_signal_types:           parseTypes(ppt_signal_types),
      annual_report_signal_types: parseTypes(annual_report_signal_types),
    });
    res.json({ slug, ticker, signal_count, systemPrompt, userPrompt });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/html-skills/:slug/run — enqueue skill run for a ticker
// Body: { ticker, fiscal_year?, quarter?, force?,
//         max_transcript_qtrs?, max_ppt_qtrs?, max_annual_report_years?,
//         transcript_signal_types?, ppt_signal_types?, annual_report_signal_types? }
router.post('/:slug/run', async (req, res, next) => {
  try {
    const {
      ticker, fiscal_year, quarter, force,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
    } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const job = await addHtmlSkillJob({
      slug:        req.params.slug,
      ticker,
      fiscal_year: fiscal_year ?? null,
      quarter:     quarter ?? null,
      force:       force === true,
      transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : null,
      ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : null,
      annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : null,
      max_transcript_qtrs:        max_transcript_qtrs     ?? null,
      max_ppt_qtrs:               max_ppt_qtrs            ?? null,
      max_annual_report_years:    max_annual_report_years  ?? null,
    });

    res.json({ success: true, message: 'Html skill job enqueued', job: { id: job.id, slug: req.params.slug, ticker, type: 'html_skill', status: 'pending' } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/html-skills/:slug/outputs/:ticker — get the latest output (full HTML) for a ticker
router.get('/:slug/outputs/:ticker', async (req, res, next) => {
  try {
    const skill = await prisma.htmlSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const output = await prisma.htmlSkillOutput.findFirst({
      where:   { skill_id: skill.id, ticker: req.params.ticker },
      orderBy: { updated_at: 'desc' },
    });
    if (!output) return res.status(404).json({ error: 'No output found for this ticker' });

    res.json(output);
  } catch (err) {
    next(err);
  }
});

// GET /api/html-skills/:slug/outputs/:ticker/:fiscal_year/:quarter — get one output (full HTML)
router.get('/:slug/outputs/:ticker/:fiscal_year/:quarter', async (req, res, next) => {
  try {
    const skill = await prisma.htmlSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const output = await prisma.htmlSkillOutput.findUnique({
      where: {
        skill_id_ticker_fiscal_year_quarter: {
          skill_id:    skill.id,
          ticker:      req.params.ticker,
          fiscal_year: req.params.fiscal_year,
          quarter:     req.params.quarter,
        },
      },
    });
    if (!output) return res.status(404).json({ error: 'Output not found' });
    res.json(output);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
