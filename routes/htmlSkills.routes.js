'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { addHtmlSkillJob } = require('../services/jobs.service');
const { buildHtmlSkillPrompt } = require('../services/htmlSkill.service');

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
      select: { id: true, slug: true, name: true, category: true, signal_types: true, model: true, max_tokens: true, is_active: true, created_at: true, updated_at: true },
    });
    res.json({ count: skills.length, skills: sortSkills(skills) });
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
    const { slug, name, skill_prompt, signal_types, category, model, max_tokens, is_active } = req.body;
    if (!slug || !name || !skill_prompt || !category) {
      return res.status(400).json({ error: 'slug, name, skill_prompt, and category are required' });
    }
    const skill = await prisma.htmlSkill.create({
      data: {
        slug, name, skill_prompt, category,
        signal_types: signal_types ?? [],
        ...(model      != null && { model }),
        ...(max_tokens != null && { max_tokens }),
        ...(is_active  != null && { is_active }),
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
    const allowed = ['name', 'skill_prompt', 'signal_types', 'category', 'model', 'max_tokens', 'is_active'];
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
// Returns signal counts for every TranscriptSignalTypeV2 enum value for a ticker.
router.get('/signals/count/:ticker', async (req, res, next) => {
  try {
    const { ticker } = req.params;

    const [rows, periodRows] = await Promise.all([
      prisma.transcriptSignalV2.groupBy({
        by:      ['signal_type'],
        where:   { ticker, is_invalidated: false },
        _count:  { signal_type: true },
        orderBy: { signal_type: 'asc' },
      }),
      prisma.transcriptSignalV2.groupBy({
        by:    ['fiscal_year', 'quarter'],
        where: { ticker, is_invalidated: false },
      }),
    ]);

    const signal_counts = rows.map(r => ({
      signal_type: r.signal_type,
      count:       r._count.signal_type,
    }));

    const total   = signal_counts.reduce((sum, s) => sum + s.count, 0);
    const periods = periodRows.map(r => ({ fiscal_year: r.fiscal_year, quarter: r.quarter }));

    res.json({ ticker, total, periods_count: periods.length, periods, signal_counts });
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

    const skill = await prisma.htmlSkill.findUnique({ where: { slug }, select: { id: true, signal_types: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const where = { ticker, is_invalidated: false };
    if (skill.signal_types.length > 0) where.signal_type = { in: skill.signal_types };

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
router.get('/:slug/prompt/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const { systemPrompt, userPrompt, signal_count } = await buildHtmlSkillPrompt({ slug, ticker });
    res.json({ slug, ticker, signal_count, systemPrompt, userPrompt });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/html-skills/:slug/run — enqueue skill run for a ticker
// Body: { ticker, fiscal_year?, quarter?, force? }
router.post('/:slug/run', async (req, res, next) => {
  try {
    const { ticker, fiscal_year, quarter, force } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const job = await addHtmlSkillJob({
      slug:        req.params.slug,
      ticker,
      fiscal_year: fiscal_year ?? null,
      quarter:     quarter ?? null,
      force:       force === true,
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
