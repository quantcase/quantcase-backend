'use strict';

const prisma = require('../config/prisma');
const { DEFAULT_TARGET_TICKERS, previewL1MultiDispatch } = require('../services/pipelineDispatch');
const { listGroups } = require('../services/companyGroups');
const { triggerJobBySlug } = require('./admin.scheduler.controller');

const L1_MULTI_SLUG = 'pipeline-dispatch-l1-multi';

// GET /admin/pipeline-dispatch/l1-multi/options
const getL1MultiOptions = async (req, res, next) => {
  try {
    const [rows, groups] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
    ]);
    const companies = rows.map(r => r.company).filter(Boolean).sort();
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

module.exports = { getL1MultiOptions, previewL1Multi, runL1Multi, getL1MultiRuns };
