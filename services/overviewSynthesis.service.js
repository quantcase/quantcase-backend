'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

// All insight types that feed the overview
const OVERVIEW_SOURCE_TYPES = ['management', 'opportunity', 'deal', 'technicals'];

/**
 * Enqueue an overview synthesis job for a given ticker.
 * Uses a deterministic jobId so duplicate submissions are idempotent.
 *
 * @param {string}  ticker         e.g. "TATAMOTORS"
 * @param {object}  [opts]
 * @param {boolean} [opts.forceRefresh]
 * @returns {Promise<{ jobId: string, bullmqId: string }>}
 */
async function enqueueOverviewSynthesisJob(ticker, opts = {}) {
  const deterministicJobId = `overview_synthesis_${ticker}`;

  if (opts.forceRefresh) {
    const queue = jobQueue.getQueue('overview_synthesis');
    const existing = await queue.getJob(deterministicJobId);
    if (existing) await existing.remove();
  }

  const bullmqJob = await jobQueue.addJob(
    'overview_synthesis',
    { ticker, ...opts },
    { jobId: deterministicJobId },
  );
  return { jobId: deterministicJobId, bullmqId: bullmqJob?.id ?? deterministicJobId };
}

/**
 * Fetch the stored overview AiInsight for a ticker.
 *
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
async function getOverviewInsight(ticker) {
  return prisma.aiInsight.findFirst({
    where:   { ticker, type: 'overview' },
    orderBy: { updated_at: 'desc' },
  });
}

/**
 * Fetch all source AiInsight rows for a ticker in one query.
 * Returns a map keyed by type.
 *
 * @param {string} ticker
 * @returns {Promise<Record<string, object>>}  e.g. { management: {...}, technicals: {...} }
 */
async function getSourceInsights(ticker) {
  const rows = await prisma.aiInsight.findMany({
    where: { ticker, type: { in: OVERVIEW_SOURCE_TYPES } },
  });
  return Object.fromEntries(rows.map(r => [r.type, r]));
}

module.exports = { enqueueOverviewSynthesisJob, getOverviewInsight, getSourceInsights, OVERVIEW_SOURCE_TYPES };
