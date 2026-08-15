'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { addHtmlCompressedSkillJob } = require('../services/jobs.service');
const { buildCompressedHtmlSkillPrompt } = require('../services/htmlCompressedSkill.service');

const router = Router();

// ── Skill CRUD ────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { includeInactive } = req.query;
    const skills = await prisma.htmlCompressedSkill.findMany({
      where:   includeInactive === 'true' ? {} : { is_active: true },
      orderBy: { slug: 'asc' },
    });
    res.json({ count: skills.length, skills });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      slug, name, category, base_l2_skill_id,
      html_template_prompt, html_template_filename, html_template_model,
      max_tokens, use_template_engine, is_active,
    } = req.body;

    if (!slug || !name || !category || !base_l2_skill_id || !html_template_prompt) {
      return res.status(400).json({ error: 'slug, name, category, base_l2_skill_id, and html_template_prompt are required' });
    }

    const skill = await prisma.htmlCompressedSkill.create({
      data: {
        slug, name, category, base_l2_skill_id,
        html_template_prompt, html_template_filename, html_template_model,
        use_template_engine,
        ...(max_tokens != null && { max_tokens }),
        ...(is_active != null && { is_active }),
      },
    });
    res.status(201).json(skill);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Skill with slug "${req.body.slug}" already exists` });
    next(err);
  }
});

router.put('/:slug', async (req, res, next) => {
  try {
    const allowed = [
      'name', 'category', 'base_l2_skill_id',
      'html_template_prompt', 'html_template_filename', 'html_template_model',
      'max_tokens', 'use_template_engine', 'is_active',
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const skill = await prisma.htmlCompressedSkill.update({ where: { slug: req.params.slug }, data });
    res.json(skill);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

router.delete('/:slug', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.update({
      where: { slug: req.params.slug },
      data:  { is_active: false },
    });
    res.json({ success: true, slug: skill.slug, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Skill not found' });
    next(err);
  }
});

// ── Configs ──────────────────────────────────────────────────────────

const CONFIG_FIELDS = [
  'name', 'html_template_prompt', 'html_template_filename', 'html_template_model', 'is_active',
];

router.get('/:slug/configs', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const configs = await prisma.htmlCompressedSkillConfig.findMany({
      where:   { skill_id: skill.id, ...(req.query.includeInactive === 'true' ? {} : { is_active: true }) },
      orderBy: { key: 'asc' },
    });
    res.json({ count: configs.length, configs });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const config = await prisma.htmlCompressedSkillConfig.findUnique({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
    });
    if (!config) return res.status(404).json({ error: 'Config not found' });
    res.json(config);
  } catch (err) {
    next(err);
  }
});

router.post('/:slug/configs', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true, html_template_prompt: true, html_template_filename: true, html_template_model: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    let {
      key, name, html_template_prompt, html_template_filename, html_template_model
    } = req.body;
    
    if (!key || !name || !html_template_prompt) {
      return res.status(400).json({ error: 'key, name, and html_template_prompt are required' });
    }

    const config = await prisma.htmlCompressedSkillConfig.create({
      data: {
        skill_id: skill.id,
        key, name, html_template_prompt, html_template_filename, html_template_model,
      },
    });

    res.status(201).json(config);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Config with key "${req.body.key}" already exists for this skill` });
    next(err);
  }
});

router.put('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const data = {};
    for (const field of CONFIG_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const config = await prisma.htmlCompressedSkillConfig.update({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
      data,
    });
    res.json(config);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Config not found' });
    next(err);
  }
});

router.delete('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const config = await prisma.htmlCompressedSkillConfig.update({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
      data:  { is_active: false },
    });

    res.json({ success: true, key: config.key, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Config not found' });
    next(err);
  }
});

// ── Prompt preview (dry-run) ──────────────────────────────────────────────────

router.get('/:slug/prompt/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const { callId, historic, configKey } = req.query;

    const result = await buildCompressedHtmlSkillPrompt({ slug, ticker, callId: callId ?? null, historic: historic === 'true', configKey: configKey ?? null });
    res.json({
      slug,
      ticker,
      callId:             callId ?? null,
      historic:           result.historic,
      configKey:          result.configKey,
      fiscal_year:        result.fiscal_year,
      quarter:            result.quarter,
      systemPrompt:       result.systemPrompt,
      html_template_prompt: result.html_template_prompt,
      html_template_filename: result.html_template_filename,
      extracted_json:     result.extracted_json,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Run ───────────────────────────────────────────────────────────────────────

router.post('/:slug/run', async (req, res, next) => {
  try {
    const { ticker, callId, force, historic, configKey } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    const skill = await prisma.htmlCompressedSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true, is_active: true },
    });
    if (!skill)           return res.status(404).json({ error: 'Skill not found' });
    if (!skill.is_active) return res.status(400).json({ error: 'Skill is inactive' });

    const job = await addHtmlCompressedSkillJob({
      slug: req.params.slug,
      ticker,
      callId,
      force:    force    === true,
      historic: historic === true,
      configKey: configKey ?? null,
    });

    res.json({
      success: true,
      message: 'Compressed skill job enqueued',
      job: { id: job.id, slug: req.params.slug, ticker, callId, historic: historic === true, configKey: configKey ?? null, type: 'html_skill_compressed', status: 'pending' },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Output fetch ──────────────────────────────────────────────────────────────

router.get('/:slug/outputs/:ticker', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { historic } = req.query;
    const output = await prisma.htmlCompressedSkillOutput.findFirst({
      where:   { skill_id: skill.id, ticker: req.params.ticker, ...(historic !== undefined && { is_historic: historic === 'true' }) },
      orderBy: { created_at: 'desc' },
    });
    if (!output) return res.status(404).json({ error: 'No output found for this ticker' });

    res.json(output);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/outputs/:ticker/history', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? '20', 10)));

    const [total, rows] = await Promise.all([
      prisma.htmlCompressedSkillOutput.count({
        where: { skill_id: skill.id, ticker: req.params.ticker },
      }),
      prisma.htmlCompressedSkillOutput.findMany({
        where:   { skill_id: skill.id, ticker: req.params.ticker },
        orderBy: { created_at: 'desc' },
        skip:    (page - 1) * size,
        take:    size,
        select: {
          id: true, ticker: true, call_id: true,
          fiscal_year: true, quarter: true,
          prompt_v: true, model: true, is_historic: true,
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

router.get('/:slug/outputs/:ticker/:fiscal_year/:quarter', async (req, res, next) => {
  try {
    const skill = await prisma.htmlCompressedSkill.findUnique({
      where:  { slug: req.params.slug },
      select: { id: true },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { fiscal_year, quarter } = req.params;
    const output = await prisma.htmlCompressedSkillOutput.findFirst({
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
