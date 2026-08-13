'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { addHtmlIncrementalSkillJob } = require('../services/jobs.service');
const {
  buildIncrementalHtmlSkillPrompt,
  fetchBaseContextOutputs,
  resolveBaseAnchorPeriod,
  transcriptPeriodRank,
  parseFiscalYear,
  defaultConfigFieldsFromSkill,
} = require('../services/htmlIncrementalSkill.service');
const { applySignalLimits } = require('../services/htmlSkill.service');

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
      slug, name, data_extraction_prompt, html_template_prompt, extraction_model, fact_validation_model, html_template_model, visual_qa_model, enable_data_validation, data_validation_loops, enable_html_validation, category,
      max_tokens,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
      market_data_signal_types, max_market_data_months,
      historic_max_transcript_qtrs, historic_max_ppt_qtrs, historic_max_annual_report_years, historic_max_market_data_months,
      strip_html, max_base_analyses,
      pinned_fiscal_year, pinned_quarter, pinned_historic,
      is_active,
    } = req.body;

    if (!slug || !name || !data_extraction_prompt || !html_template_prompt || !category) {
      return res.status(400).json({ error: 'slug, name, data_extraction_prompt, html_template_prompt, and category are required' });
    }

    const skill = await prisma.htmlIncrementalSkill.create({
      data: {
        slug, name, data_extraction_prompt, html_template_prompt, extraction_model, fact_validation_model, html_template_model, visual_qa_model, enable_data_validation, data_validation_loops, enable_html_validation, category,
        transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : [],
        ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : [],
        annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : [],
        market_data_signal_types:   Array.isArray(market_data_signal_types)   ? market_data_signal_types   : [],
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
        ...(pinned_fiscal_year       != null && { pinned_fiscal_year }),
        ...(pinned_quarter           != null && { pinned_quarter }),
        ...(pinned_historic          != null && { pinned_historic }),
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
      'name', 'data_extraction_prompt', 'html_template_prompt', 'extraction_model', 'fact_validation_model', 'html_template_model', 'visual_qa_model', 'enable_data_validation', 'data_validation_loops', 'enable_html_validation', 'category', 'max_tokens',
      'transcript_signal_types', 'ppt_signal_types', 'annual_report_signal_types',
      'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years',
      'market_data_signal_types', 'max_market_data_months',
      'historic_max_transcript_qtrs', 'historic_max_ppt_qtrs', 'historic_max_annual_report_years', 'historic_max_market_data_months',
      'strip_html', 'max_base_analyses',
      'pinned_fiscal_year', 'pinned_quarter', 'pinned_historic',
      'is_active',
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

// ── Configs (named, alternate settings bundles for a skill) ───────────────────
// Purely additive: a skill keeps behaving exactly as it does today when no
// config is selected. Configs let an admin save multiple full settings bundles
// (prompt + filters + caps + model) under one skill — e.g. one per data-
// availability shape — and pick one explicitly by key on /run or /prompt.
// There's no auto-detection here; availability is checked in the monitoring
// system, and the admin selects a config only once they've confirmed it fits.

const CONFIG_FIELDS = [
  'name', 'data_extraction_prompt', 'html_template_prompt', 'extraction_model', 'fact_validation_model', 'html_template_model', 'visual_qa_model', 'enable_data_validation', 'data_validation_loops', 'enable_html_validation',
  'transcript_signal_types', 'ppt_signal_types', 'annual_report_signal_types',
  'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years',
  'market_data_signal_types', 'max_market_data_months',
  'historic_max_transcript_qtrs', 'historic_max_ppt_qtrs', 'historic_max_annual_report_years', 'historic_max_market_data_months',
  'max_tokens', 'strip_html',
  'is_active',
];

// GET /api/html-incremental-skills/:slug/configs?includeInactive=true
router.get('/:slug/configs', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const configs = await prisma.htmlIncrementalSkillConfig.findMany({
      where:   { skill_id: skill.id, ...(req.query.includeInactive === 'true' ? {} : { is_active: true }) },
      orderBy: { key: 'asc' },
    });
    res.json({ count: configs.length, configs });
  } catch (err) {
    next(err);
  }
});

// GET /api/html-incremental-skills/:slug/configs/:key
router.get('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const config = await prisma.htmlIncrementalSkillConfig.findUnique({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
    });
    if (!config) return res.status(404).json({ error: 'Config not found' });
    res.json(config);
  } catch (err) {
    next(err);
  }
});

// POST /api/html-incremental-skills/:slug/configs
// Body: { key, name, data_extraction_prompt, html_template_prompt, extraction_model, fact_validation_model, html_template_model, visual_qa_model, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types?, ppt_signal_types?, annual_report_signal_types?,
//         max_transcript_qtrs?, max_ppt_qtrs?, max_annual_report_years?,
//         market_data_signal_types?, max_market_data_months?,
//         historic_max_transcript_qtrs?, historic_max_ppt_qtrs?, historic_max_annual_report_years?, historic_max_market_data_months?,
//         model?, max_tokens?, strip_html? }
router.post('/:slug/configs', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const {
      key, name, data_extraction_prompt, html_template_prompt, extraction_model, fact_validation_model, html_template_model, visual_qa_model, enable_data_validation, data_validation_loops, enable_html_validation,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
      market_data_signal_types, max_market_data_months,
      historic_max_transcript_qtrs, historic_max_ppt_qtrs, historic_max_annual_report_years, historic_max_market_data_months,
      max_tokens, strip_html,
    } = req.body;

    if (!key || !name || !data_extraction_prompt || !html_template_prompt) {
      return res.status(400).json({ error: 'key, name, data_extraction_prompt, and html_template_prompt are required' });
    }

    const config = await prisma.htmlIncrementalSkillConfig.create({
      data: {
        skill_id: skill.id,
        key, name, data_extraction_prompt, html_template_prompt, extraction_model, fact_validation_model, html_template_model, visual_qa_model, enable_data_validation, data_validation_loops, enable_html_validation,
        transcript_signal_types:    Array.isArray(transcript_signal_types)    ? transcript_signal_types    : [],
        ppt_signal_types:           Array.isArray(ppt_signal_types)           ? ppt_signal_types           : [],
        annual_report_signal_types: Array.isArray(annual_report_signal_types) ? annual_report_signal_types : [],
        market_data_signal_types:   Array.isArray(market_data_signal_types)   ? market_data_signal_types   : [],
        ...(max_transcript_qtrs               != null && { max_transcript_qtrs }),
        ...(max_ppt_qtrs                      != null && { max_ppt_qtrs }),
        ...(max_annual_report_years           != null && { max_annual_report_years }),
        ...(max_market_data_months            != null && { max_market_data_months }),
        ...(historic_max_transcript_qtrs      != null && { historic_max_transcript_qtrs }),
        ...(historic_max_ppt_qtrs             != null && { historic_max_ppt_qtrs }),
        ...(historic_max_annual_report_years  != null && { historic_max_annual_report_years }),
        ...(historic_max_market_data_months   != null && { historic_max_market_data_months }),
                ...(max_tokens != null && { max_tokens }),
        ...(strip_html != null && { strip_html }),
      },
    });

    // A config key is a bare string tag — nothing stops it from being used
    // on a CompanyGroup while only existing under some skills, which fails
    // resolution (404 on run, all-zero on L2 preview) for any other lens.
    // Backfill every other active skill missing this key with a default
    // clone of *its own* current top-level fields (same shape as
    // scripts/seedAvailabilityConfigs.js's t1/t2/t3 seeding) so the key
    // resolves everywhere from the moment it's created — admin can then
    // tweak each lens's copy independently, same as t1/t2/t3 today.
    const otherSkills = await prisma.htmlIncrementalSkill.findMany({
      where: { is_active: true, id: { not: skill.id } },
    });
    let propagatedTo = [];
    if (otherSkills.length) {
      const alreadyHave = await prisma.htmlIncrementalSkillConfig.findMany({
        where:  { key, skill_id: { in: otherSkills.map(s => s.id) } },
        select: { skill_id: true },
      });
      const alreadyHaveIds = new Set(alreadyHave.map(c => c.skill_id));
      const missing = otherSkills.filter(s => !alreadyHaveIds.has(s.id));
      if (missing.length) {
        await prisma.htmlIncrementalSkillConfig.createMany({
          data: missing.map(s => ({
            skill_id: s.id,
            key, name,
            ...defaultConfigFieldsFromSkill(s),
          })),
          skipDuplicates: true,
        });
        propagatedTo = missing.map(s => s.slug);
      }
    }

    res.status(201).json({ ...config, propagatedTo });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Config with key "${req.body.key}" already exists for this skill` });
    next(err);
  }
});

// PUT /api/html-incremental-skills/:slug/configs/:key
router.put('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const data = {};
    for (const field of CONFIG_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const config = await prisma.htmlIncrementalSkillConfig.update({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
      data,
    });
    res.json(config);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Config not found' });
    next(err);
  }
});

// DELETE /api/html-incremental-skills/:slug/configs/:key  (soft delete)
// Mirrors POST's create-time propagation (a config key is meant to be one
// cross-lens concept, not a per-skill coincidence — see POST .../configs) by
// also deactivating every other skill's copy of this same key, not just this
// one — otherwise a "deleted" key keeps resolving fine (and doing real work)
// for every other lens, which isn't what deleting it means to an admin.
router.delete('/:slug/configs/:key', async (req, res, next) => {
  try {
    const skill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const config = await prisma.htmlIncrementalSkillConfig.update({
      where: { skill_id_key: { skill_id: skill.id, key: req.params.key } },
      data:  { is_active: false },
    });

    const { count } = await prisma.htmlIncrementalSkillConfig.updateMany({
      where: { key: req.params.key, skill_id: { not: skill.id }, is_active: true },
      data:  { is_active: false },
    });

    res.json({ success: true, key: config.key, is_active: false, deactivatedElsewhere: count });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Config not found' });
    next(err);
  }
});

// ── Signal count (same helper as original flow, for admin) ────────────────────

// GET /api/html-incremental-skills/signals/count/:ticker
// Lightweight per-source-doc-type signal count for config-editor badges — mirrors
// GET /api/html-skills/signals/count/:ticker exactly (same by_source shape), plus
// two additions for this flow's two modes:
//
//   - historic=true (default): unscoped by any base — same semantics as the
//     original endpoint. Pass max_transcript_qtrs / max_ppt_qtrs /
//     max_annual_report_years / transcript_signal_types / ppt_signal_types /
//     annual_report_signal_types as a live preview of hypothetical caps while
//     editing; omit them for the unfiltered total.
//
//   - historic=false: requires slug. Bounded below by the *current* base's
//     anchor period first (pin-aware — same fetchBaseContextOutputs/
//     resolveBaseAnchorPeriod logic as GET /:slug/signals/:ticker?historic=false
//     and the real incremental run, so this can't drift from either), then the
//     same optional override caps are applied on top for the live-editing
//     preview. Returns base_context_count/base_missing alongside by_source.
router.get('/signals/count/:ticker', async (req, res, next) => {
  try {
    const { ticker } = req.params;
    const {
      slug, historic,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
    } = req.query;

    const isHistoric = historic !== 'false';
    if (!isHistoric && !slug) {
      return res.status(400).json({ error: 'slug is required when historic=false' });
    }

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

    const rows = await prisma.transcriptSignalV2.findMany({
      where:   { ticker, is_invalidated: false },
      select:  { signal_type: true, fiscal_year: true, quarter: true, source_doc_type: true, call_date: true },
      orderBy: [{ call_date: 'desc' }],
    });

    let pool                = rows;
    let base_context_count  = 0;
    let base_missing        = false;

    if (!isHistoric) {
      const skill = await prisma.htmlIncrementalSkill.findUnique({
        where:  { slug },
        select: { id: true, max_base_analyses: true, pinned_fiscal_year: true, pinned_quarter: true, pinned_historic: true },
      });
      if (!skill) return res.status(404).json({ error: 'Skill not found' });

      const baseOutputs  = await fetchBaseContextOutputs(skill, ticker, null, null);
      base_context_count = baseOutputs.length;
      base_missing        = baseOutputs.length === 0;

      if (base_missing) {
        pool = [];
      } else {
        const anchor     = await resolveBaseAnchorPeriod(baseOutputs);
        const anchorRank = transcriptPeriodRank(anchor.fiscal_year, anchor.quarter);
        const anchorYear = parseFiscalYear(anchor.fiscal_year);

        pool = rows.filter(r => {
          if (r.source_doc_type === 'annual_report') {
            const y = parseFiscalYear(r.fiscal_year);
            return y == null || anchorYear == null || y > anchorYear;
          }
          const rank = transcriptPeriodRank(r.fiscal_year, r.quarter);
          return rank == null || anchorRank == null || rank > anchorRank;
        });
      }
    }

    const filtered = hasLimits ? applySignalLimits(pool, limits) : pool;

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
      historic: isHistoric,
      base_context_count,
      base_missing,
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

// GET /api/html-incremental-skills/:slug/signals/:ticker?historic=true|false
// Returns the exact signals that would be sent to the LLM when running this skill.
// - historic=true (default): full raw pool of matching-type signals, unfiltered —
//   the same for both modes today, since historic has no lower bound.
// - historic=false: bounded below by the current base's own anchor period (the
//   live pinned base if one is set, else the N-most-recent per max_base_analyses)
//   — i.e. only signals that are actually new since the base, matching what an
//   incremental run would pull. No callId/target upper bound yet since no call
//   has been picked at this point in the UI flow. Re-fetch this after pinning/
//   unpinning a base — the anchor (and therefore this count) changes with it.
router.get('/:slug/signals/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const historic = req.query.historic !== 'false';

    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where:  { slug },
      select: {
        id: true,
        transcript_signal_types: true,
        ppt_signal_types: true,
        annual_report_signal_types: true,
        max_base_analyses: true,
        pinned_fiscal_year: true,
        pinned_quarter: true,
        pinned_historic: true,
      },
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

    let poolRows          = rows;
    let base_context_count = 0;
    let base_missing       = false;

    if (!historic) {
      const baseOutputs = await fetchBaseContextOutputs(skill, ticker, null, null);
      base_context_count = baseOutputs.length;
      base_missing        = baseOutputs.length === 0;

      if (base_missing) {
        poolRows = [];
      } else {
        const anchor     = await resolveBaseAnchorPeriod(baseOutputs);
        const anchorRank = transcriptPeriodRank(anchor.fiscal_year, anchor.quarter);
        const anchorYear = parseFiscalYear(anchor.fiscal_year);

        poolRows = rows.filter(r => {
          if (r.source_doc_type === 'annual_report') {
            const y = parseFiscalYear(r.fiscal_year);
            return y == null || anchorYear == null || y > anchorYear;
          }
          const rank = transcriptPeriodRank(r.fiscal_year, r.quarter);
          return rank == null || anchorRank == null || rank > anchorRank;
        });
      }
    }

    const signals = poolRows.map(r => ({
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

    res.json({ ticker, slug, historic, base_context_count, base_missing, total: signals.length, signals });
  } catch (err) {
    next(err);
  }
});

// ── Prompt preview (dry-run) ──────────────────────────────────────────────────

// GET /api/html-incremental-skills/:slug/prompt/:ticker?callId=&historic=true&configKey=
// configKey is optional — selects a saved HtmlIncrementalSkillConfig (see the
// Configs section below) in place of the skill's own top-level fields. Omit
// it to preview the skill's default behavior, unchanged from before.
router.get('/:slug/prompt/:ticker', async (req, res, next) => {
  try {
    const { slug, ticker } = req.params;
    const { callId, historic, configKey } = req.query;

    const result = await buildIncrementalHtmlSkillPrompt({ slug, ticker, callId: callId ?? null, historic: historic === 'true', configKey: configKey ?? null });
    res.json({
      slug,
      ticker,
      callId:             callId ?? null,
      historic:           result.historic,
      configKey:          result.configKey,
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
// Body: { ticker, callId, force?, historic?, configKey? }
// historic=true skips base-context stitching and uses the skill's historic_* signal windows
// (falling back to the normal windows if unset) — for first-ever runs on a ticker or a
// deliberate full-history recompute. Frontend should offer this when GET .../outputs/:ticker 404s.
// configKey (optional) runs a saved config's prompt/filters/caps instead of the skill's own —
// pick one explicitly once you've confirmed (elsewhere, in the monitoring system) which
// sources are actually available for this ticker. Omit for the skill's default behavior.
router.post('/:slug/run', async (req, res, next) => {
  try {
    const { ticker, callId, force, historic, configKey } = req.body;
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
      configKey: configKey ?? null,
    });

    res.json({
      success: true,
      message: 'Incremental skill job enqueued',
      job: { id: job.id, slug: req.params.slug, ticker, callId, historic: historic === true, configKey: configKey ?? null, type: 'html_skill_incremental', status: 'pending' },
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

// ── Base pin (global, per skill) ────────────────────────────────────────────
// Pinning is set via the skill config itself (PUT /:slug with
// pinned_fiscal_year/pinned_quarter/pinned_historic) — one decision applies to
// every ticker: an incremental run for ticker X uses X's output at that exact
// period as base, or has no base at all if X doesn't have one there yet. See
// fetchBaseContextOutputs in services/htmlIncrementalSkill.service.js.

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
