'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

/**
 * Enqueue an AI Insight Synthesis job (Layer 3 LLM verdict).
 * The worker will auto-compose stale lenses before calling the LLM.
 *
 * @param {string} callId       e.g. "TATAMOTORS_FY2025_Q4"
 * @param {string} insightType  "management" | "opportunity" | "deal"
 * @param {object} opts
 * @param {boolean} [opts.forceRefresh]  Skip cache and re-generate even if lens scores unchanged
 * @returns {Promise<{jobId: string, bullmqId: string}>}
 */
async function enqueueAiInsightSynthesisJob(callId, insightType, opts = {}) {
  const deterministicJobId = `ai_insight_synthesis_${callId}_${insightType}`;
  const { job } = await jobQueue.addJob(
    'ai_insight_synthesis',
    { callId, insightType, ...opts },
    { jobId: deterministicJobId }
  );
  return { jobId: deterministicJobId, bullmqId: job?.id ?? deterministicJobId };
}

/**
 * Fetch the most recent non-stale AI Insight for a ticker + type.
 *
 * @param {string} ticker
 * @param {string} insightType
 * @returns {Promise<object|null>}
 */
async function getAiInsight(ticker, insightType) {
  return prisma.aiInsight.findFirst({
    where:   { ticker, type: insightType },
    orderBy: { updated_at: 'desc' },
  });
}

/**
 * List all AI Insights for a ticker (all types).
 *
 * @param {string} ticker
 * @returns {Promise<object[]>}
 */
async function listAiInsightsByTicker(ticker) {
  return prisma.aiInsight.findMany({
    where:   { ticker },
    orderBy: { type: 'asc' },
  });
}

module.exports = {
  enqueueAiInsightSynthesisJob,
  getAiInsight,
  listAiInsightsByTicker,
};
