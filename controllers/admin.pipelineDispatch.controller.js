'use strict';

const prisma = require('../config/prisma');
const { DEFAULT_TARGET_TICKERS, previewL1MultiDispatch, previewL1MultiDispatchCsv, previewL2MultiDispatch, previewL2MultiDispatchCsv, previewL3MultiDispatch, previewL3MultiDispatchCsv, previewL2CompressedMultiDispatch, previewL2CompressedMultiDispatchCsv } = require('../services/pipelineDispatch');
const { L3_TYPES, L4_TYPE } = require('../services/postHtmlAnalysis.service');
const { listGroups } = require('../services/companyGroups');
const { triggerJobBySlug } = require('./admin.scheduler.controller');

const L1_MULTI_SLUG = 'pipeline-dispatch-l1-multi';
const L2_MULTI_SLUG = 'pipeline-dispatch-l2-multi';
const L3_MULTI_SLUG = 'pipeline-dispatch-l3-multi';
const L2_COMPRESSED_MULTI_SLUG = 'pipeline-dispatch-l2-compressed-multi';

// GET /admin/pipeline-dispatch/l1-multi/options
// companies mirrors getTranscriptStocks' earnings_calls + annual_reports merge
// (services/calls.service.js) — otherwise annual-only tickers (e.g. ORIENTHOT,
// no earnings call ingested) are picked up fine by processAnnualReports but
// can never be selected here in the first place.
const getL1MultiOptions = async (req, res, next) => {
  try {
    const [callRows, reportRows, groups] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
    ]);
    const companies = [...new Set([
      ...callRows.map(r => r.company),
      ...reportRows.map(r => r.company),
    ])].filter(Boolean).sort();
    const companyGroups = groups.map(g => ({ slug: g.slug, name: g.name, filter_type: g.filter_type }));
    res.json({ defaultTickers: DEFAULT_TARGET_TICKERS, companies, companyGroups });
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l1-multi/preview — dry run, no side effects, not logged as a run
const previewL1Multi = async (req, res, next) => {
  try {
    const result = await previewL1MultiDispatch({ ...req.body, fromUI: true });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l1-multi/preview/csv — full, uncapped
// document-coverage report as a downloadable CSV (ignores limit/latest/
// arOnly/noAr — those are run-time caps, not relevant to a coverage report).
// Same flattened-column format as L2's CSV (see services/pipelineDispatch/csvReport.js),
// values are 1/0 presence per period rather than a signal count.
const previewL1MultiCsv = async (req, res, next) => {
  try {
    // Headers only — previewL1MultiDispatchCsv writes the body itself (see
    // csvReport.js#writeSignalReportCsv) once its data is ready, streaming
    // row-by-row instead of building the full CSV string first. Safe to let
    // errors still reach the normal error handler: everything that can throw
    // here happens before the first res.write() call.
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="l1-document-coverage-report.csv"');
    await previewL1MultiDispatchCsv(req.body, res);
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l1-multi/run — fire-and-forget, logged to scheduler_runs
const runL1Multi = async (req, res, next) => {
  try {
    const result = await triggerJobBySlug(L1_MULTI_SLUG, { ...req.body, fromUI: true });
    res.json({ success: true, message: 'L1 multi-dispatch triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

// GET /admin/pipeline-dispatch/l1-multi/runs
const getL1MultiRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: L1_MULTI_SLUG }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });

    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const runs = await prisma.schedulerRun.findMany({
      where:   { job_id: job.id },
      orderBy: { started_at: 'desc' },
      take:    limit,
    });
    res.json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
};

// GET /admin/pipeline-dispatch/l2-multi/options
// companyGroups includes config_key so the admin screen can show current
// tagging state; configKeys is the distinct set of config keys defined
// across any active skill's configs, for populating the tag-picker dropdown
// (see PUT /admin/company-groups/:slug { config_key } for the tag action
// itself — no dedicated tag endpoint, it's just a field on the group).
const getL2MultiOptions = async (req, res, next) => {
  try {
    const [callRows, reportRows, groups, skills, configs] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
      prisma.htmlIncrementalSkill.findMany({ where: { is_active: true }, select: { slug: true, name: true }, orderBy: { slug: 'asc' } }),
      prisma.htmlIncrementalSkillConfig.findMany({ where: { is_active: true }, select: { key: true, name: true }, distinct: ['key'] }),
    ]);
    const companies = [...new Set([
      ...callRows.map(r => r.company),
      ...reportRows.map(r => r.company),
    ])].filter(Boolean).sort();
    const companyGroups = groups.map(g => ({ slug: g.slug, name: g.name, filter_type: g.filter_type, config_key: g.config_key }));
    const configKeys = [...new Map(configs.map(c => [c.key, c])).values()].sort((a, b) => a.key.localeCompare(b.key));
    res.json({ skills, companies, companyGroups, configKeys });
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l2-multi/preview — dry run, no jobs enqueued, no LLM calls
const previewL2Multi = async (req, res, next) => {
  try {
    const result = await previewL2MultiDispatch(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l2-multi/preview/csv — same report as
// /preview, as a downloadable CSV (one row per ticker, source/period columns
// flattened since CSV has no nested-header concept — see toCsv in
// l2MultiDispatch.service.js). Same body shape as /preview.
const previewL2MultiCsv = async (req, res, next) => {
  try {
    // Headers only — previewL2MultiDispatchCsv writes the body itself,
    // streaming row-by-row (see previewL1MultiCsv above for why this is
    // safe for error handling).
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="l2-signal-report-${req.body.slug}.csv"`);
    await previewL2MultiDispatchCsv(req.body, res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l2-multi/run — fire-and-forget, logged to scheduler_runs
const runL2Multi = async (req, res, next) => {
  try {
    const result = await triggerJobBySlug(L2_MULTI_SLUG, req.body);
    res.json({ success: true, message: 'L2 multi-dispatch triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

const regenerateHtmlL2Multi = async (req, res, next) => {
  try {
    req.body.regenerateHtml = true;
    const result = await triggerJobBySlug(L2_MULTI_SLUG, req.body);
    res.json({ success: true, message: 'L2 multi regenerate-html triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

// GET /admin/pipeline-dispatch/l2-multi/runs
const getL2MultiRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: L2_MULTI_SLUG }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });

    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const runs = await prisma.schedulerRun.findMany({
      where:   { job_id: job.id },
      orderBy: { started_at: 'desc' },
      take:    limit,
    });
    res.json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
};

// ─── L3 Multi-Dispatch (post-html-analysis runs) ─────────────────────────────

// GET /admin/pipeline-dispatch/l3-multi/options
// companies mirrors L1/L2's own company universe (earnings_calls + annual_reports
// merge). layerTypes gives the frontend the valid type set per layerId (l3:
// management/opportunity/deal, l4: summary) so it can build the type picker
// without hardcoding INSIGHT_LENSES/L4_TYPE client-side.
const getL3MultiOptions = async (req, res, next) => {
  try {
    const [callRows, reportRows, groups] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
    ]);
    const companies = [...new Set([
      ...callRows.map(r => r.company),
      ...reportRows.map(r => r.company),
    ])].filter(Boolean).sort();
    const companyGroups = groups.map(g => ({ slug: g.slug, name: g.name, filter_type: g.filter_type }));
    const layerTypes = { l3: L3_TYPES, l4: [L4_TYPE] };
    res.json({ defaultTickers: DEFAULT_TARGET_TICKERS, companies, companyGroups, layerTypes });
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l3-multi/preview — dry run, no side effects, not logged as a run
const previewL3Multi = async (req, res, next) => {
  try {
    const result = await previewL3MultiDispatch(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l3-multi/preview/csv — same availability
// report as /preview, one row per (ticker, type), full uncapped dump.
const previewL3MultiCsv = async (req, res, next) => {
  try {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="l3-availability-report-${req.body.layerId || 'l3'}.csv"`);
    await previewL3MultiDispatchCsv(req.body, res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// POST /admin/pipeline-dispatch/l3-multi/run — fire-and-forget, logged to scheduler_runs
const runL3Multi = async (req, res, next) => {
  try {
    const result = await triggerJobBySlug(L3_MULTI_SLUG, req.body);
    res.json({ success: true, message: 'L3 multi-dispatch triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

// GET /admin/pipeline-dispatch/l3-multi/runs
const getL3MultiRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: L3_MULTI_SLUG }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });

    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const runs = await prisma.schedulerRun.findMany({
      where:   { job_id: job.id },
      orderBy: { started_at: 'desc' },
      take:    limit,
    });
    res.json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
};

// ─── L2 Compressed Multi-Dispatch ──────────────────────────────────────────────

const getL2CompressedMultiOptions = async (req, res, next) => {
  try {
    const [callRows, reportRows, groups, skills, configs] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
      prisma.htmlCompressedSkill.findMany({ where: { is_active: true }, select: { slug: true, name: true }, orderBy: { slug: 'asc' } }),
      prisma.htmlCompressedSkillConfig.findMany({ where: { is_active: true }, select: { key: true, name: true }, distinct: ['key'] }),
    ]);
    const companies = [...new Set([
      ...callRows.map(r => r.company),
      ...reportRows.map(r => r.company),
    ])].filter(Boolean).sort();
    const companyGroups = groups.map(g => ({ slug: g.slug, name: g.name, filter_type: g.filter_type, config_key: g.config_key }));
    const configKeys = [...new Map(configs.map(c => [c.key, c])).values()].sort((a, b) => a.key.localeCompare(b.key));
    res.json({ skills, companies, companyGroups, configKeys });
  } catch (err) {
    next(err);
  }
};

const previewL2CompressedMulti = async (req, res, next) => {
  try {
    const { slug, ...options } = req.body;
    const result = await previewL2CompressedMultiDispatch(slug, options);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

const previewL2CompressedMultiCsv = async (req, res, next) => {
  try {
    const { slug, ...options } = req.body;
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="l2-compressed-report-${slug}.csv"`);
    await previewL2CompressedMultiDispatchCsv(slug, options, res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const runL2CompressedMulti = async (req, res, next) => {
  try {
    const result = await triggerJobBySlug(L2_COMPRESSED_MULTI_SLUG, req.body);
    res.json({ success: true, message: 'L2 Compressed multi-dispatch triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

const regenerateHtmlL2CompressedMulti = async (req, res, next) => {
  try {
    req.body.regenerateHtml = true;
    const result = await triggerJobBySlug(L2_COMPRESSED_MULTI_SLUG, req.body);
    res.json({ success: true, message: 'L2 Compressed multi regenerate-html triggered', run_id: result.run_id });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

const getL2CompressedMultiRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: L2_COMPRESSED_MULTI_SLUG }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });

    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const runs = await prisma.schedulerRun.findMany({
      where:   { job_id: job.id },
      orderBy: { started_at: 'desc' },
      take:    limit,
    });
    res.json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
};

// ─── Lens Tier Configs Management ──────────────────────────────────────────

const PREFERRED_LENS_ORDER = [
  'capital-allocation',
  'customer-distribution',
  'competition',
  'disclosure-honesty',
  'guidance-credibility',
  'earning-quality',
  'earnings-forecast',
  'financial-strength',
  'promoter-activity',
  'industry-analysis',
];

const ALLOWED_CONFIG_FIELDS = [
  'name', 'data_extraction_prompt', 'html_template_prompt', 'extraction_model', 'fact_validation_model',
  'html_template_model', 'visual_qa_model', 'enable_data_validation', 'data_validation_loops',
  'use_template_engine', 'html_template_filename', 'enable_html_validation',
  'transcript_signal_types', 'ppt_signal_types', 'annual_report_signal_types', 'market_data_signal_types',
  'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years', 'max_market_data_months',
  'historic_max_transcript_qtrs', 'historic_max_ppt_qtrs', 'historic_max_annual_report_years',
  'historic_max_market_data_months', 'max_tokens', 'strip_html', 'is_active',
];

// GET /admin/pipeline-dispatch/lens-tier-configs
const getLensTierConfigs = async (req, res, next) => {
  try {
    const skills = await prisma.htmlIncrementalSkill.findMany({
      where: { is_active: true },
      select: { id: true, slug: true, name: true, category: true },
    });

    skills.sort((a, b) => {
      const idxA = PREFERRED_LENS_ORDER.indexOf(a.slug);
      const idxB = PREFERRED_LENS_ORDER.indexOf(b.slug);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    const configs = await prisma.htmlIncrementalSkillConfig.findMany({
      where: {
        is_active: true,
        skill_id: { in: skills.map(s => s.id) },
      },
      orderBy: [{ key: 'asc' }, { skill_id: 'asc' }],
    });

    const KNOWN_VARIANTS = {
      t1: 'Full (T1) — transcript + ppt + annual report',
      t2: 'No Transcript (T2) — ppt + annual report only',
      t3: 'Annual Report Only (T3)',
    };

    const keyMap = new Map();
    for (const c of configs) {
      if (!keyMap.has(c.key)) {
        keyMap.set(c.key, {
          key: c.key,
          name: KNOWN_VARIANTS[c.key] || c.name || c.key,
          lensCount: 0,
        });
      }
      keyMap.get(c.key).lensCount++;
    }

    const tiers = Array.from(keyMap.values()).sort((a, b) => {
      const order = { t1: 1, t2: 2, t3: 3 };
      const ordA = order[a.key] || 99;
      const ordB = order[b.key] || 99;
      if (ordA !== ordB) return ordA - ordB;
      return a.key.localeCompare(b.key);
    });

    const skillIdToSlug = new Map(skills.map(s => [s.id, s.slug]));
    const configsByTier = {};
    for (const tier of tiers) {
      configsByTier[tier.key] = {};
    }
    for (const c of configs) {
      const slug = skillIdToSlug.get(c.skill_id);
      if (slug && configsByTier[c.key]) {
        configsByTier[c.key][slug] = c;
      }
    }

    res.json({
      tiers,
      lenses: skills,
      configs: configsByTier,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/pipeline-dispatch/lens-tier-configs/:tierKey/:slug
const updateLensTierConfig = async (req, res, next) => {
  try {
    const { tierKey, slug } = req.params;
    const skill = await prisma.htmlIncrementalSkill.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true },
    });
    if (!skill) return res.status(404).json({ error: `Skill '${slug}' not found` });

    const existing = await prisma.htmlIncrementalSkillConfig.findUnique({
      where: { skill_id_key: { skill_id: skill.id, key: tierKey } },
    });
    if (!existing) return res.status(404).json({ error: `Config for key '${tierKey}' and skill '${slug}' not found` });

    const data = {};
    for (const field of ALLOWED_CONFIG_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }

    if (req.body.model !== undefined) {
      data.extraction_model = req.body.model;
      data.fact_validation_model = req.body.model;
      data.html_template_model = req.body.model;
      data.visual_qa_model = req.body.model;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const updated = await prisma.htmlIncrementalSkillConfig.update({
      where: { id: existing.id },
      data,
    });

    res.json({ success: true, config: updated });
  } catch (err) {
    next(err);
  }
};

// POST /admin/pipeline-dispatch/lens-tier-configs/bulk-update
const bulkUpdateLensTierConfigs = async (req, res, next) => {
  try {
    const { tierKey, slugs, updates } = req.body;
    if (!tierKey) return res.status(400).json({ error: 'tierKey is required' });
    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'updates object is required and must not be empty' });
    }

    const ALLOWED_BULK_FIELDS = [
      'extraction_model', 'fact_validation_model', 'html_template_model', 'visual_qa_model',
      'max_transcript_qtrs', 'max_ppt_qtrs', 'max_annual_report_years', 'max_market_data_months',
      'historic_max_transcript_qtrs', 'historic_max_ppt_qtrs', 'historic_max_annual_report_years',
      'historic_max_market_data_months', 'enable_data_validation', 'data_validation_loops',
      'enable_html_validation', 'max_tokens', 'strip_html',
    ];

    const cleanData = {};
    for (const field of ALLOWED_BULK_FIELDS) {
      if (updates[field] !== undefined) cleanData[field] = updates[field];
    }
    if (updates.model !== undefined) {
      cleanData.extraction_model = updates.model;
      cleanData.fact_validation_model = updates.model;
      cleanData.html_template_model = updates.model;
      cleanData.visual_qa_model = updates.model;
    }

    if (Object.keys(cleanData).length === 0) {
      return res.status(400).json({ error: 'No supported bulk fields provided' });
    }

    const skillWhere = { is_active: true };
    if (Array.isArray(slugs) && slugs.length > 0) {
      skillWhere.slug = { in: slugs };
    }
    const skills = await prisma.htmlIncrementalSkill.findMany({
      where: skillWhere,
      select: { id: true, slug: true },
    });
    if (skills.length === 0) {
      return res.status(404).json({ error: 'No matching skills found' });
    }

    const skillIds = skills.map(s => s.id);

    const updateResult = await prisma.htmlIncrementalSkillConfig.updateMany({
      where: {
        skill_id: { in: skillIds },
        key: tierKey,
        is_active: true,
      },
      data: cleanData,
    });

    res.json({
      success: true,
      updatedCount: updateResult.count,
      tierKey,
      appliedFields: Object.keys(cleanData),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getL1MultiOptions, previewL1Multi, previewL1MultiCsv, runL1Multi, getL1MultiRuns,
  getL2MultiOptions, previewL2Multi, previewL2MultiCsv, runL2Multi, regenerateHtmlL2Multi, getL2MultiRuns,
  getL3MultiOptions, previewL3Multi, previewL3MultiCsv, runL3Multi, getL3MultiRuns,
  getL2CompressedMultiOptions, previewL2CompressedMulti, previewL2CompressedMultiCsv, runL2CompressedMulti, regenerateHtmlL2CompressedMulti, getL2CompressedMultiRuns,
  getLensTierConfigs, updateLensTierConfig, bulkUpdateLensTierConfigs,
};
