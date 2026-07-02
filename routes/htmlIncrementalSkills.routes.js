'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { addHtmlIncrementalSkillJob } = require('../services/jobs.service');
const { buildIncrementalHtmlSkillPrompt } = require('../services/htmlIncrementalSkill.service');

const router = Router();

// ── Skill CRUD ────────────────────────────────────────────────────────────────

// GET /api/html-incremental-skills
router.get('/', async (req, res, next) => {
  try {
    const { includeInactive } = req.query;
    const skills = await prisma.htmlIncrementalSkill.findMany({
      where:   includeInactive === 'true' ? {} : { is_active: true },
      orderBy: { slug: 'asc' },
    });
    res.json({ count: skills.length, skills });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-incremental-skills/:slug
router.get('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  } catch (err) {
    next(err);
  }
});

// POST /api/html-incremental-skills
router.post('/', async (req, res, next) => {
  try {
    const {
      slug, name, skill_prompt, category,
      model, max_tokens,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
      market_data_signal_types, max_market_data_months,
      historic_max_transcript_qtrs, historic_max_ppt_qtrs, historic_max_annual_report_years, historic_max_market_data_months,
      strip_html, max_base_analyses,
      is_active,
    } = req.body;

    if (!slug || !name || !skill_prompt || !category) {
      return res.status(400).json({ error: 'slug, name, skill_prompt, and category are required' });
    }

    const skill = await prisma.htmlIncrementalSkill.create({
      data: {
        slug, name, skill_prompt, category,
        transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : [],
        ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : [],
        annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : [],
        market_data_signal_types:   Array.isArray(market_data_signal_types)   ? market_data_signal_types   : [],
        ...(model                    != null && { model }),
        ...(max_tokens               != null && { max_tokens }),
        ...(max_transcript_qtrs      != null && { max_transcript_qtrs }),
        ...(max_ppt_qtrs             != null && { max_ppt_qtrs }),
        ...(max_annual_report_years  != null && { max_annual_report_years }),
        ...(max_market_data_months   != null && { max_market_data_months }),
        ...(historic_max_transcript_qtrs     != null && { historic_max_transcript_qtrs }),
        ...(historic_max_ppt_qtrs            != null && { historic_max_ppt_qtrs }),
        ...(historic_max_annual_report_years != null && { historic_max_annual_report_years }),
        ...(historic_max_market_data_months  != null && { historic_max_market_data_months }),
        ...(strip_html               != null && { strip_html }),
        ...(max_base_analyses        != null && { max_base_analyses }),
        ...(is_active                != null && { is_active }),
      },
    });
    res.status(201).json(skill);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Skill with slug "${req.body.slug}" already exists` });
    next(err);
  }
});

// PUT /api/html-incremental-skills/:slug
router.put('/:slug', async (req, res, next) => {
  try {
    const allowed = [
      'name', 'skill_prompt', 'category', 'model', 'max_tokens',
      'transcript_signal_types', 'ppt_signal_types', 'annual_report_signal_types',
      'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years',
      'market_data_signal_types', 'max_market_data_months',
      'historic_max_transcript_qtrs', 'historic_max_ppt_qtrs', 'historic_max_annual_report_years', 'historic_max_market_data_months',
      'strip_html', 'max_base_analyses', 'is_active',
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const skill = await prisma.htmlIncrementalSkill.update({ where: { slug: req.params.slug }, data });
    res.json(skill);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

// DELETE /api/html-incremental-skills/:slug  (soft delete)
router.delete('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.update({
      where: { slug: req.params.slug },
      data:  { is_active: false },
    });
    res.json({ success: true, slug: skill.slug, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

// ── Signal count (same helper as original flow, for admin) ────────────────────

// GET /api/html-incremental-skills/signals/count/:ticker
router.get('/signals/count/:ticker', async (req, res, next) => {
  try {
    const { ticker } = req.params;
    const count = await prisma.transcriptSignalV2.count({
      where: { ticker, is_invalidated: false },
    });
    res.json({ ticker, total: count });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-incremental-skills/:slug/signals/:ticker
// Returns the exact signals that would be sent to the LLM when running this skill,
// with all signal-content fields included.
router.get('/:slug/signals/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;

    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug },
      select: { id: true, transcript_signal_types: true, ppt_signal_types: true, annual_report_signal_types: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

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

// ── Prompt preview (dry-run) ──────────────────────────────────────────────────

// GET /api/html-incremental-skills/:slug/prompt/:ticker?callId=&historic=true
router.get('/:slug/prompt/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const { callId, historic } = req.query;

    const result = await buildIncrementalHtmlSkillPrompt({ slug, ticker, callId: callId ?? null, historic: historic === 'true' });
    res.json({
      slug,
      ticker,
      callId:             callId ?? null,
      historic:           result.historic,
      fiscal_year:        result.fiscal_year,
      quarter:            result.quarter,
      signal_count:       result.signal_count,
      raw_signal_count:   result.raw_signal_count,
      base_context_count: result.base_context_count,
      systemPrompt:       result.systemPrompt,
      userPrompt:         result.userPrompt,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Run ───────────────────────────────────────────────────────────────────────

// POST /api/html-incremental-skills/:slug/run
// Body: { ticker, callId, force?, historic? }
// historic=true skips base-context stitching and uses the skill's historic_* signal windows
// (falling back to the normal windows if unset) — for first-ever runs on a ticker or a
// deliberate full-history recompute. Frontend should offer this when GET .../outputs/:ticker 404s.
router.post('/:slug/run', async (req, res, next) => {
  try {
    const { ticker, callId, force, historic } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true, is_active: true },
    });
    if (!skill)           return res.status(404).json({ error: 'Skill not found' });
    if (!skill.is_active) return res.status(400).json({ error: 'Skill is inactive' });

    const job = await addHtmlIncrementalSkillJob({
      slug: req.params.slug,
      ticker,
      callId,
      force:    force    === true,
      historic: historic === true,
    });

    res.json({
      success: true,
      message: 'Incremental skill job enqueued',
      job: { id: job.id, slug: req.params.slug, ticker, callId, historic: historic === true, type: 'html_skill_incremental', status: 'pending' },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Output fetch ──────────────────────────────────────────────────────────────

// GET /api/html-incremental-skills/:slug/outputs/:ticker?historic=true|false
// Returns the latest output for the ticker (most recent by created_at).
// Omit `historic` to get the latest regardless of mode (useful for the
// "does anything exist yet" check that decides whether to prompt for a historic run).
router.get('/:slug/outputs/:ticker', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { historic } = req.query;
    const output = await prisma.htmlIncrementalSkillOutput.findFirst({
      where:   { skill_id: skill.id, ticker: req.params.ticker, ...(historic !== undefined && { is_historic: historic === 'true' }) },
      orderBy: { created_at: 'desc' },
    });
    if (!output) return res.status(404).json({ error: 'No output found for this ticker' });

    res.json(output);
  } catch (err) {
    next(err);
  }
});

// GET /api/html-incremental-skills/:slug/outputs/:ticker/history
// Returns all historical outputs for admin to browse and pick a pin (see POST .../pin below).
// Query params: page (default 1), size (default 20, max 100)
router.get('/:slug/outputs/:ticker/history', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? '20', 10)));

    const [total, rows] = await Promise.all([
      prisma.htmlIncrementalSkillOutput.count({
        where: { skill_id: skill.id, ticker: req.params.ticker },
      }),
      prisma.htmlIncrementalSkillOutput.findMany({
        where:   { skill_id: skill.id, ticker: req.params.ticker },
        orderBy: { created_at: 'desc' },
        skip:    (page - 1) * size,
        take:    size,
        select: {
          id: true, ticker: true, call_id: true,
          fiscal_year: true, quarter: true,
          prompt_v: true, model: true, is_historic: true, is_pinned_base: true,
          input_tokens: true, output_tokens: true, cost_usd: true,
          created_at: true, updated_at: true,
        },
      }),
    ]);

    res.json({ ticker: req.params.ticker, total, page, size, rows });
  } catch (err) {
    next(err);
  }
});

// ── Base pin (per ticker) ───────────────────────────────────────────────────────
// Pinning a specific output forces incremental runs for that ticker to always use it
// as base context, overriding the "N most recent outputs" default. At most one
// pinned row per (skill, ticker) — setting a new pin clears any previous one.

// POST /api/html-incremental-skills/:slug/outputs/:ticker/pin
// Body: { fiscal_year, quarter, historic? }  — identifies the exact output row to pin.
router.post('/:slug/outputs/:ticker/pin', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { ticker } = req.params;
    const { fiscal_year = null, quarter = null, historic = false } = req.body;

    // findFirst, not findUnique: Postgres doesn't treat NULL = NULL in unique
    // constraints, so findUnique on the compound key rejects lookups where
    // fiscal_year/quarter are null (true for all seeded rows).
    const target = await prisma.htmlIncrementalSkillOutput.findFirst({
      where: { skill_id: skill.id, ticker, fiscal_year, quarter, is_historic: historic === true },
    });
    if (!target) return res.status(404).json({ error: 'Output not found for that ticker/period/mode' });

    const [, pinned] = await prisma.$transaction([
      prisma.htmlIncrementalSkillOutput.updateMany({
        where: { skill_id: skill.id, ticker, is_pinned_base: true },
        data:  { is_pinned_base: false },
      }),
      prisma.htmlIncrementalSkillOutput.update({
        where: { id: target.id },
        data:  { is_pinned_base: true },
      }),
    ]);

    res.json({ success: true, pinned });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/html-incremental-skills/:slug/outputs/:ticker/pin
// Clears any pinned base for the ticker, reverting to the "N most recent outputs" default.
router.delete('/:slug/outputs/:ticker/pin', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const result = await prisma.htmlIncrementalSkillOutput.updateMany({
      where: { skill_id: skill.id, ticker: req.params.ticker, is_pinned_base: true },
      data:  { is_pinned_base: false },
    });

    res.json({ success: true, unpinned: result.count });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-incremental-skills/:slug/outputs/:ticker/:fiscal_year/:quarter?historic=true|false
// Fetch one exact output by period (use quarter "null" for annual-report-only periods).
// `historic` defaults to false (incremental) since a period can now have both a
// historic and an incremental row.
router.get('/:slug/outputs/:ticker/:fiscal_year/:quarter', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { fiscal_year, quarter } = req.params;
    // findFirst, not findUnique: Postgres doesn't treat NULL = NULL in unique
    // constraints, so findUnique on the compound key rejects lookups where
    // fiscal_year/quarter are null (true for all seeded rows). The app already
    // guarantees at most one match via findFirst-before-create elsewhere.
    const output = await prisma.htmlIncrementalSkillOutput.findFirst({
      where: {
        skill_id:    skill.id,
        ticker:      req.params.ticker,
        fiscal_year: fiscal_year === 'null' ? null : fiscal_year,
        quarter:     quarter     === 'null' ? null : quarter,
        is_historic: req.query.historic === 'true',
      },
    });
    if (!output) return res.status(404).json({ error: 'Output not found' });
    res.json(output);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
