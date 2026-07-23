'use strict';

// Shared BullMQ plumbing for the `technicals_analysis` queue (the L3 decision-intelligence
// worker in workers/technicals.js). Extracted so both the per-symbol screener read-path
// (controllers/screener.controller.js) and the admin bulk trigger
// (services/admin.technicals.service.js) enqueue with identical, idempotent semantics.

const jobQueue = require('./jobQueue');

const TECHNICALS_QUEUE = 'technicals_analysis';

/**
 * Deterministic per-symbol job id — makes enqueue idempotent while a job is in flight.
 * Note: BullMQ rejects ':' in custom job ids ("Custom Id cannot contain :"), hence '-'.
 */
function technicalsJobId(symbol) { return `technicals-${symbol}`; }

/**
 * Ensure an insight job exists for `symbol` and describe it to the caller.
 *
 * Uses a deterministic jobId so that a frontend polling this endpoint every few seconds
 * does not enqueue a duplicate job per poll (BullMQ auto-increments ids otherwise, and the
 * previous fire-and-forget `addJob` produced one job per request).
 *
 * A `failed` terminal state is reported as-is rather than silently retried, so the caller
 * can stop polling immediately instead of waiting out its full timeout. `force` (from
 * ?refresh=1) clears a terminal job and starts a fresh one.
 *
 * @returns {Promise<{id: string, status: 'queued'|'processing'|'failed', error?: string}>}
 */
async function ensureTechnicalsJob(symbol, { force = false } = {}) {
  const queue = jobQueue.getQueue(TECHNICALS_QUEUE);
  const jobId = technicalsJobId(symbol);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active')                            return { id: jobId, status: 'processing' };
    if (state === 'waiting' || state === 'delayed')    return { id: jobId, status: 'queued' };
    if (state === 'failed' && !force) {
      return { id: jobId, status: 'failed', error: existing.failedReason || 'Job failed' };
    }
    // Terminal (completed, or failed with force) — remove so the id can be reused.
    await existing.remove();
  }

  await jobQueue.addJob(TECHNICALS_QUEUE, { symbol }, { jobId });
  return { id: jobId, status: 'queued' };
}

/**
 * Describe an in-flight (queued/processing) job for `symbol`, or null if none is running.
 * Never enqueues. Terminal states (completed/failed) return null — callers that care about
 * failure read it from the status endpoint's own branch.
 */
async function inFlightTechnicalsJob(symbol) {
  try {
    const job = await jobQueue.getQueue(TECHNICALS_QUEUE).getJob(technicalsJobId(symbol));
    if (!job) return null;
    const state = await job.getState();
    if (state === 'active')                         return { id: job.id, status: 'processing', progress: job.progress ?? 0 };
    if (state === 'waiting' || state === 'delayed') return { id: job.id, status: 'queued',     progress: 0 };
    return null;
  } catch (err) {
    console.error('[technicals] Failed to read job state:', err.message);
    return null;
  }
}

module.exports = { TECHNICALS_QUEUE, technicalsJobId, ensureTechnicalsJob, inFlightTechnicalsJob };
