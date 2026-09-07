'use strict';

const prisma = require('../config/prisma');
const jobQueue = require('../lib/jobQueue');
const {
  TECHNICALS_QUEUE,
  technicalsJobId,
  ensureTechnicalsJob,
} = require('../lib/technicalsQueue');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Hard cap so a single request can't flood the queue with thousands of LLM jobs.
const MAX_TICKERS = 500;

/** Uppercase, trim, drop blanks, de-dupe — preserving first-seen order. */
function normalizeTickers(tickers) {
  return [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
}

/** Count results by their `status` field, e.g. { queued: 3, exists: 1 }. */
function tally(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

/**
 * Enqueue a `technical-intelligence` regeneration job for each ticker.
 *
 * Idempotent per symbol (deterministic jobId), so re-submitting the same batch while jobs
 * are in flight will not create duplicates. By default, tickers that already have a stored
 * technicals insight are skipped (status `exists`) — pass `force: true` to regenerate all.
 *
 * @param {{ tickers: string[], force?: boolean }} params
 * @returns {Promise<{ requested: number, counts: object, results: Array }>}
 */
async function bulkEnqueueTechnicals({ tickers, force = false, skipLimit = false }) {
  const symbols = normalizeTickers(tickers);
  if (!symbols.length) throw new HttpError(400, 'At least one valid ticker is required');
  if (!skipLimit && symbols.length > MAX_TICKERS) {
    throw new HttpError(400, `Too many tickers (${symbols.length}); max ${MAX_TICKERS} per request`);
  }

  // Tickers that already have a cached insight are skipped unless force=true.
  const haveInsight = force
    ? new Set()
    : new Set(
        (
          await prisma.aiInsight.findMany({
            where: { type: 'technicals', ticker: { in: symbols } },
            select: { ticker: true },
          })
        ).map((r) => r.ticker),
      );

  const results = [];
  for (const ticker of symbols) {
    if (haveInsight.has(ticker)) {
      results.push({ ticker, jobId: null, status: 'exists' });
      continue;
    }
    try {
      const job = await ensureTechnicalsJob(ticker, { force });
      results.push({ ticker, jobId: job.id, status: job.status, ...(job.error && { error: job.error }) });
    } catch (err) {
      results.push({ ticker, jobId: null, status: 'error', error: err.message });
    }
  }

  return { requested: symbols.length, counts: tally(results), results };
}

/**
 * Batch-poll the technicals state for many tickers without recomputing anything.
 *
 * Reads the stored insight's `updated_at` and the BullMQ job state per symbol. Never
 * enqueues. Per-ticker `status` is one of: `processing` | `queued` | `ready` | `failed` |
 * `missing`. An in-flight job takes precedence over a stale stored insight (matches the
 * single-symbol /technicals/status semantics — the worker overwrites the row only on success).
 *
 * @param {{ tickers: string[] }} params
 * @returns {Promise<{ requested: number, counts: object, results: Array }>}
 */
async function bulkTechnicalsStatus({ tickers }) {
  const symbols = normalizeTickers(tickers);
  if (!symbols.length) throw new HttpError(400, 'At least one valid ticker is required');
  if (symbols.length > MAX_TICKERS) {
    throw new HttpError(400, `Too many tickers (${symbols.length}); max ${MAX_TICKERS} per request`);
  }

  const insights = await prisma.aiInsight.findMany({
    where: { type: 'technicals', ticker: { in: symbols } },
    select: { ticker: true, updated_at: true },
  });
  const updatedAtByTicker = new Map(insights.map((i) => [i.ticker, i.updated_at]));

  const queue = jobQueue.getQueue(TECHNICALS_QUEUE);
  const results = [];
  for (const ticker of symbols) {
    const job = await queue.getJob(technicalsJobId(ticker));
    const state = job ? await job.getState() : null;
    const updatedAt = updatedAtByTicker.get(ticker) ?? null;

    let status;
    if (state === 'active') status = 'processing';
    else if (state === 'waiting' || state === 'delayed') status = 'queued';
    else if (updatedAt) status = 'ready';
    else if (state === 'failed') status = 'failed';
    else status = 'missing';

    results.push({
      ticker,
      status,
      updatedAt,
      ...(status === 'failed' && job?.failedReason ? { error: job.failedReason } : {}),
    });
  }

  return { requested: symbols.length, counts: tally(results), results };
}

module.exports = { bulkEnqueueTechnicals, bulkTechnicalsStatus, HttpError };
