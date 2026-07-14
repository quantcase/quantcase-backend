'use strict';

const prisma = require('../config/prisma');
const { DEFAULT_TARGET_TICKERS, previewL1MultiDispatch, previewL1MultiDispatchCsv, previewL2MultiDispatch, previewL2MultiDispatchCsv, previewL3MultiDispatch, previewL3MultiDispatchCsv } = require('../services/pipelineDispatch');
const { L3_TYPES, L4_TYPE } = require('../services/postHtmlAnalysis.service');
const { listGroups } = require('../services/companyGroups');
const { triggerJobBySlug } = require('./admin.scheduler.controller');

const L1_MULTI_SLUG = 'pipeline-dispatch-l1-multi';
const L2_MULTI_SLUG = 'pipeline-dispatch-l2-multi';
const L3_MULTI_SLUG = 'pipeline-dispatch-l3-multi';

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
    const result = await previewL1MultiDispatch(req.body);
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
    const result = await triggerJobBySlug(L1_MULTI_SLUG, req.body);
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

module.exports = {
  getL1MultiOptions, previewL1Multi, previewL1MultiCsv, runL1Multi, getL1MultiRuns,
  getL2MultiOptions, previewL2Multi, previewL2MultiCsv, runL2Multi, getL2MultiRuns,
  getL3MultiOptions, previewL3Multi, previewL3MultiCsv, runL3Multi, getL3MultiRuns,
};
