'use strict';

const prisma   = require('../config/prisma');
const {
  getAllQueueStats,
  getQueueStats,
  getFailedJobs,
  ALL_QUEUES,
} = require('../services/monitoring.service');

const {
  fetchKpiMaps,
  fetchTimeSeries,
  fetchMarketSnapshot,
  fetchOhlcvBars,
  fetchPeTimeSeries,
  REGISTRY,
} = require('../utils/formulaRegistry');

// ─── Queue health ─────────────────────────────────────────────────────────────

const getQueues = async (req, res, next) => {
  try {
    const stats = await getAllQueueStats();
    const total = stats.reduce((acc, q) => {
      acc.waiting  += q.waiting  ?? 0;
      acc.active   += q.active   ?? 0;
      acc.failed   += q.failed   ?? 0;
      acc.delayed  += q.delayed  ?? 0;
      return acc;
    }, { waiting: 0, active: 0, failed: 0, delayed: 0 });
    res.json({ queues: stats, totals: total });
  } catch (err) {
    next(err);
  }
};

const getQueue = async (req, res, next) => {
  try {
    if (!ALL_QUEUES.includes(req.params.name)) {
      return res.status(404).json({ error: `Queue "${req.params.name}" not found` });
    }
    const [stats, failed] = await Promise.all([
      getQueueStats(req.params.name),
      getFailedJobs(req.params.name, 20),
    ]);
    res.json({ ...stats, recent_failures: failed });
  } catch (err) {
    next(err);
  }
};

// ─── Scheduler runs ───────────────────────────────────────────────────────────

const getSchedulerStatus = async (req, res, next) => {
  try {
    const jobs = await prisma.schedulerJob.findMany({ orderBy: { created_at: 'asc' } });

    const jobsWithRuns = await Promise.all(jobs.map(async job => {
      const lastRun = await prisma.schedulerRun.findFirst({
        where:   { job_id: job.id },
        orderBy: { started_at: 'desc' },
      });
      // Compute next fire time from cron expression
      let next_run = null;
      try {
        const cronParser = require('cron-parser');
        const interval   = cronParser.parseExpression(job.cron_expression, { tz: 'Asia/Kolkata' });
        next_run = interval.next().toDate();
      } catch {}
      return { ...job, last_run: lastRun ?? null, next_run };
    }));

    res.json({ count: jobs.length, jobs: jobsWithRuns });
  } catch (err) {
    next(err);
  }
};

// ─── Pipeline coverage ────────────────────────────────────────────────────────

const getPipelineCoverage = async (req, res, next) => {
  try {
    const [l1Transcript, l1Ppt, l1Annual, l2, l3] = await Promise.all([
      prisma.transcriptSignalV2.groupBy({ by: ['ticker'], where: { is_invalidated: false, source_doc_type: 'transcript' }, _count: true }),
      prisma.transcriptSignalV2.groupBy({ by: ['ticker'], where: { is_invalidated: false, source_doc_type: 'ppt' }, _count: true }),
      prisma.transcriptSignalV2.groupBy({ by: ['ticker'], where: { is_invalidated: false, source_doc_type: 'annual_report' }, _count: true }),
      prisma.lensScore.groupBy({ by: ['ticker'], _count: true }),
      prisma.aiInsight.groupBy({ by: ['ticker'], _count: true }),
    ]);

    res.json({
      l1: {
        transcript:    { companies: l1Transcript.length },
        ppt:           { companies: l1Ppt.length },
        annual_report: { companies: l1Annual.length },
      },
      l2: { companies: l2.length },
      l3: { companies: l3.length },
    });
  } catch (err) {
    next(err);
  }
};

const getPipelineFailures = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const failures = await prisma.pipelineJobFailure.findMany({
      orderBy: { failed_at: 'desc' },
      take:    limit,
    });
    res.json({ count: failures.length, failures });
  } catch (err) {
    next(err);
  }
};

// ─── Signal stats ─────────────────────────────────────────────────────────────

const getSignalStats = async (req, res, next) => {
  try {
    const [byType, bySource] = await Promise.all([
      prisma.transcriptSignalV2.groupBy({ by: ['signal_type'], where: { is_invalidated: false }, _count: true, orderBy: { _count: { signal_type: 'desc' } } }),
      prisma.transcriptSignalV2.groupBy({ by: ['source_doc_type'], where: { is_invalidated: false }, _count: true }),
    ]);
    const total = bySource.reduce((s, r) => s + r._count, 0);
    res.json({ total, by_signal_type: byType, by_source: bySource });
  } catch (err) {
    next(err);
  }
};

// ─── Overview dashboard ───────────────────────────────────────────────────────

const getOverview = async (req, res, next) => {
  try {
    const [queueStats, schedulerJobs, l1Count, l2Count, l3Count] = await Promise.all([
      getAllQueueStats(),
      prisma.schedulerJob.findMany({ select: { id: true, slug: true, is_active: true } }),
      prisma.transcriptSignalV2.groupBy({ by: ['ticker'], where: { is_invalidated: false }, _count: true }).then(r => r.length),
      prisma.lensScore.groupBy({ by: ['ticker'], _count: true }).then(r => r.length),
      prisma.aiInsight.groupBy({ by: ['ticker'], _count: true }).then(r => r.length),
    ]);

    const lastRunPerJob = await Promise.all(schedulerJobs.map(async j => {
      const run = await prisma.schedulerRun.findFirst({ where: { job_id: j.id }, orderBy: { started_at: 'desc' } });
      return { slug: j.slug, is_active: j.is_active, last_run: run ?? null };
    }));

    const queueTotals = queueStats.reduce((acc, q) => {
      acc.waiting += q.waiting ?? 0; acc.active += q.active ?? 0; acc.failed += q.failed ?? 0;
      return acc;
    }, { waiting: 0, active: 0, failed: 0 });

    res.json({
      queues:    { totals: queueTotals },
      scheduler: lastRunPerJob,
      pipeline:  { l1_companies: l1Count, l2_companies: l2Count, l3_companies: l3Count },
    });
  } catch (err) {
    next(err);
  }
};

// ─── BSE discovered URLs (written by Server 2, read here on Server 1) ────────

const getBseDiscovered = async (req, res, next) => {
  try {
    const days  = Math.min(parseInt(req.query.days ?? '7', 10), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw`
      SELECT
        scrip_cd, company_name, scrape_date,
        array_length(transcript_urls,    1) AS transcript_count,
        array_length(ppt_urls,           1) AS ppt_count,
        array_length(annual_report_urls, 1) AS annual_report_count,
        transcript_urls, ppt_urls, annual_report_urls,
        updated_at
      FROM bse_discovered_urls
      WHERE scrape_date >= ${since}::date
      ORDER BY scrape_date DESC, company_name ASC
    `;

    const stats = rows.reduce(
      (acc, r) => {
        acc.transcripts    += Number(r.transcript_count    ?? 0);
        acc.ppts           += Number(r.ppt_count           ?? 0);
        acc.annual_reports += Number(r.annual_report_count ?? 0);
        return acc;
      },
      { transcripts: 0, ppts: 0, annual_reports: 0 },
    );

    res.json({ days, companies: rows.length, stats, rows });
  } catch (err) {
    next(err);
  }
};

const getBseDiscoveredCompany = async (req, res, next) => {
  try {
    const scripCd = parseInt(req.params.scripCd, 10);
    const rows = await prisma.$queryRaw`
      SELECT *
      FROM bse_discovered_urls
      WHERE scrip_cd = ${scripCd}
      ORDER BY scrape_date DESC
      LIMIT 30
    `;
    if (!rows.length) return res.status(404).json({ error: 'No records for this scrip_cd' });
    res.json({ scrip_cd: scripCd, company_name: rows[0].company_name, rows });
  } catch (err) {
    next(err);
  }
};

// ─── KPI data query (via formulaRegistry) ────────────────────────────────────

const getKpiRegistry = (_req, res) => {
  const entries = Object.entries(REGISTRY ?? {}).map(([id, def]) => ({
    id,
    name:            def.name,
    unit:            def.unit,
    computationType: def.computationType,
  }));
  res.json({ count: entries.length, entries });
};

const getKpis = async (req, res, next) => {
  try {
    const { ticker } = req.params;
    // source: 'annual' (default) or 'quarterly'
    const source = req.query.source ?? 'annual';
    const data = await fetchKpiMaps(prisma, ticker, source);
    res.json({ ticker, source, data });
  } catch (err) {
    next(err);
  }
};

const getKpiTimeseries = async (req, res, next) => {
  try {
    const { ticker, kpiAbbr } = req.params;
    const data = await fetchTimeSeries(prisma, ticker, kpiAbbr);
    res.json({ ticker, kpi: kpiAbbr, data });
  } catch (err) {
    next(err);
  }
};

const getMarketSnapshot = async (req, res, next) => {
  try {
    const data = await fetchMarketSnapshot(prisma, req.params.ticker);
    res.json({ ticker: req.params.ticker, data });
  } catch (err) {
    next(err);
  }
};

const getMarketOhlcv = async (req, res, next) => {
  try {
    const { ticker } = req.params;
    const since = req.query.since ? new Date(req.query.since) : undefined;
    const data = await fetchOhlcvBars(prisma, ticker, { since });
    res.json({ ticker, data });
  } catch (err) {
    next(err);
  }
};

const getMarketPe = async (req, res, next) => {
  try {
    const months = req.query.months ? parseInt(req.query.months, 10) : undefined;
    const data = await fetchPeTimeSeries(prisma, req.params.ticker, { months });
    res.json({ ticker: req.params.ticker, data });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getOverview,
  getQueues, getQueue,
  getSchedulerStatus,
  getPipelineCoverage, getPipelineFailures,
  getSignalStats,
  getBseDiscovered, getBseDiscoveredCompany,
  getKpiRegistry, getKpis, getKpiTimeseries,
  getMarketSnapshot, getMarketOhlcv, getMarketPe,
};
