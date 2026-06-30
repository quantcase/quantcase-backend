'use strict';

/**
 * Scheduler core — startup-register pattern.
 *
 * Jobs are loaded from DB once at startup and registered via setTimeout.
 * Each job self-reschedules after firing. Before every fire, fresh config
 * is fetched from DB so config JSON changes are always picked up without
 * re-registration.
 *
 * cron_expression or is_active changes: the admin API POSTs to the scheduler's
 * internal HTTP endpoint (/reload/:slug), which calls reregisterJob() here.
 */

const cronParser = require('cron-parser');
const prisma     = require('../config/prisma');
const { dispatch }                  = require('./executor');
const { logRun, completeRun, failRun } = require('./registry');

// slug → { timer: TimeoutHandle, jobId: string, nextFire: Date }
const timers = new Map();

function computeNext(cronExpression) {
  const interval = cronParser.parseExpression(cronExpression, { tz: 'Asia/Kolkata' });
  const nextFire = interval.next().toDate();
  return { delay: Math.max(0, nextFire.getTime() - Date.now()), nextFire };
}

function scheduleJob(job) {
  // Cancel existing timer for this slug before re-registering
  const existing = timers.get(job.slug);
  if (existing) clearTimeout(existing.timer);

  let delay, nextFire;
  try {
    ({ delay, nextFire } = computeNext(job.cron_expression));
  } catch (err) {
    console.error(`[scheduler] ${job.slug} — invalid cron "${job.cron_expression}": ${err.message}`);
    return;
  }

  const timer = setTimeout(() => fireJob(job.id, job.slug), delay);
  timers.set(job.slug, { timer, jobId: job.id, nextFire });
  console.log(`[scheduler] ${job.slug} → ${nextFire.toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

function cancelJob(slug) {
  const existing = timers.get(slug);
  if (existing) {
    clearTimeout(existing.timer);
    timers.delete(slug);
    console.log(`[scheduler] ${slug} cancelled`);
  }
}

async function fireJob(jobId, slug) {
  // Fetch fresh config from DB right before firing — picks up any config JSON changes
  const job = await prisma.schedulerJob.findUnique({ where: { id: jobId } });
  if (!job || !job.is_active) {
    console.log(`[scheduler] ${slug} skipped (inactive or removed)`);
    timers.delete(slug);
    return;
  }

  console.log(`[scheduler] Firing ${job.slug} (${job.job_type})`);
  let runId;
  try {
    runId = await logRun(job.id);
    const meta = await dispatch(job.job_type, job.config ?? {});
    await completeRun(runId, meta ?? {});
    console.log(`[scheduler] ${job.slug} completed`, meta ?? '');
  } catch (err) {
    console.error(`[scheduler] ${job.slug} failed:`, err.message);
    if (runId) await failRun(runId, err).catch(() => {});
  }

  // Re-fetch to get latest cron_expression in case it changed, then reschedule
  const updated = await prisma.schedulerJob.findUnique({ where: { id: jobId } });
  if (updated?.is_active) scheduleJob(updated);
  else timers.delete(slug);
}

// Called by the internal HTTP endpoint when admin updates cron_expression or is_active
async function reregisterJob(slug) {
  const job = await prisma.schedulerJob.findUnique({ where: { slug } });
  if (!job || !job.is_active) {
    cancelJob(slug);
    return { cancelled: true, slug };
  }
  scheduleJob(job);
  return { scheduled: true, slug, nextFire: timers.get(slug)?.nextFire };
}

async function loadAndRegisterAll() {
  for (const [, { timer }] of timers) clearTimeout(timer);
  timers.clear();

  const jobs = await prisma.schedulerJob.findMany({ where: { is_active: true } });
  console.log(`[scheduler] Registering ${jobs.length} active jobs`);
  for (const job of jobs) scheduleJob(job);
}

function getStatus() {
  return [...timers.entries()].map(([slug, { jobId, nextFire }]) => ({
    slug, jobId, nextFire,
  }));
}

module.exports = { loadAndRegisterAll, reregisterJob, cancelJob, getStatus };
