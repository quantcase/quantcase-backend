'use strict';

const prisma = require('../config/prisma');

async function logRun(jobId) {
  const run = await prisma.schedulerRun.create({
    data: { job_id: jobId, status: 'running', started_at: new Date() },
  });
  return run.id;
}

async function completeRun(runId, meta = {}) {
  const { records_processed, ...rest } = meta;
  await prisma.schedulerRun.update({
    where: { id: runId },
    data: {
      status:            'completed',
      ended_at:          new Date(),
      records_processed: records_processed ?? null,
      metadata:          Object.keys(rest).length ? rest : undefined,
    },
  });
}

async function failRun(runId, err) {
  await prisma.schedulerRun.update({
    where: { id: runId },
    data: {
      status:   'failed',
      ended_at: new Date(),
      error:    err?.message ?? String(err),
    },
  });
}

// Returns the most recent run for a job within the last `windowMs` milliseconds (dedup guard).
async function findRecentRun(jobId, windowMs) {
  const since = new Date(Date.now() - windowMs);
  return prisma.schedulerRun.findFirst({
    where: { job_id: jobId, started_at: { gte: since } },
    orderBy: { started_at: 'desc' },
  });
}

module.exports = { logRun, completeRun, failRun, findRecentRun };
