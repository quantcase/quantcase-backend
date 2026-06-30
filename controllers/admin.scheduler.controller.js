'use strict';

const prisma = require('../config/prisma');

const UPDATABLE = ['name', 'description', 'job_type', 'cron_expression', 'is_active', 'config'];

// Fields that affect scheduling — changes trigger a re-registration signal to the scheduler process
const SCHEDULE_FIELDS = new Set(['cron_expression', 'is_active']);

const SCHEDULER_PORT = parseInt(process.env.SCHEDULER_PORT ?? '8001', 10);

async function notifyScheduler(slug) {
  try {
    await fetch(`http://127.0.0.1:${SCHEDULER_PORT}/reload/${encodeURIComponent(slug)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Scheduler may not be running — DB is updated, change takes effect on next scheduler start
  }
}

const listJobs = async (req, res, next) => {
  try {
    const { includeInactive } = req.query;
    const jobs = await prisma.schedulerJob.findMany({
      where:   includeInactive === 'true' ? {} : { is_active: true },
      orderBy: { created_at: 'asc' },
    });
    res.json({ count: jobs.length, jobs });
  } catch (err) {
    next(err);
  }
};

const getJob = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: req.params.slug } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });
    res.json(job);
  } catch (err) {
    next(err);
  }
};

const createJob = async (req, res, next) => {
  try {
    const { slug, name, description, job_type, cron_expression, is_active, config } = req.body;
    if (!slug || !name || !job_type || !cron_expression) {
      return res.status(400).json({ error: 'slug, name, job_type, and cron_expression are required' });
    }
    const job = await prisma.schedulerJob.create({
      data: {
        slug,
        name,
        description: description ?? null,
        job_type,
        cron_expression,
        is_active:   is_active ?? true,
        config:      config    ?? {},
      },
    });
    if (job.is_active) await notifyScheduler(job.slug);
    res.status(201).json(job);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Job with slug "${req.body.slug}" already exists` });
    next(err);
  }
};

const updateJob = async (req, res, next) => {
  try {
    const data = {};
    for (const key of UPDATABLE) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    const job = await prisma.schedulerJob.update({ where: { slug: req.params.slug }, data });

    // Notify scheduler to re-register this job if schedule-affecting fields changed
    const scheduleChanged = Object.keys(data).some(k => SCHEDULE_FIELDS.has(k));
    if (scheduleChanged) await notifyScheduler(job.slug);

    res.json(job);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Scheduler job not found' });
    next(err);
  }
};

const deleteJob = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.update({
      where: { slug: req.params.slug },
      data:  { is_active: false },
    });
    // Notify scheduler to cancel this job's timer
    await notifyScheduler(job.slug);
    res.json({ success: true, slug: job.slug, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Scheduler job not found' });
    next(err);
  }
};

const getJobRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
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

// POST /admin/scheduler-jobs/:slug/run — manual trigger (imports executor lazily to avoid circular deps)
const triggerJob = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: req.params.slug } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });
    if (!job.is_active) return res.status(400).json({ error: 'Job is inactive — activate it first or pass force=true in config' });

    // Fire-and-forget: run async, return immediately
    const { dispatch } = require('../scheduler/executor');
    const { logRun, completeRun, failRun } = require('../scheduler/registry');
    const runId = await logRun(job.id);
    dispatch(job.job_type, job.config)
      .then(meta  => completeRun(runId, meta))
      .catch(err  => failRun(runId, err));

    res.json({ success: true, message: 'Job triggered', run_id: runId });
  } catch (err) {
    next(err);
  }
};

module.exports = { listJobs, getJob, createJob, updateJob, deleteJob, getJobRuns, triggerJob };
