'use strict';

/**
 * Admin control for failed summarization-v2 chunk jobs that failed due to LLM
 * output truncation specifically. Everything else (other error types, plain
 * retries, general queue browsing) is handled directly via Bull Board — this
 * only covers the one thing Bull Board can't do: split a truncated chunk's
 * page range in half and requeue it.
 *
 * Deliberately Redis-only (no Postgres table) — BullMQ's own `failed` set
 * (7-day retention, see `lib/jobQueue.js`) is the source of truth.
 *
 * Splitting is safe by construction: each worker's `source_hash` (the
 * already-processed dedup key) is computed from `url:pageStart:pageEnd`, so
 * two half-range sub-chunks always get distinct hashes from each other and
 * from the original failed range — no collision risk.
 */

const jobQueue = require('../lib/jobQueue');

const QUEUE_CONFIG = {
  summarization_v2:               { idField: 'callId',   urlField: 'transcriptUrl' },
  summarization_v2_ppt:           { idField: 'callId',   urlField: 'pptUrl' },
  summarization_v2_annual_report: { idField: 'reportId', urlField: 'annualReportUrl' },
};
const KNOWN_QUEUES = Object.keys(QUEUE_CONFIG);

const TRUNCATION_RE   = /truncated at token limit/i;
const FAILED_SCAN_CAP = 1000; // how many of a queue's failed jobs to scan for truncation matches

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// queueName omitted -> all 3 known queues; given -> just that one (validated)
function resolveQueues(queueName) {
  if (!queueName) return KNOWN_QUEUES;
  if (!QUEUE_CONFIG[queueName]) throw statusError(400, `Unknown queue "${queueName}"`);
  return [queueName];
}

function toRow(queueName, j) {
  const cfg       = QUEUE_CONFIG[queueName];
  const pageStart = j.data?.pageStart;
  const pageEnd   = j.data?.pageEnd;
  return {
    queue:        queueName,
    id:           j.id,
    docId:        j.data?.[cfg.idField] ?? null,
    url:          j.data?.[cfg.urlField] ?? null,
    pageStart,
    pageEnd,
    pages:        (typeof pageStart === 'number' && typeof pageEnd === 'number') ? `${pageStart + 1}-${pageEnd}` : null,
    lineageId:    j.data?.lineageId ?? null,
    chunkIndex:   j.data?.chunkIndex ?? null,
    totalChunks:  j.data?.totalChunks ?? null,
    attemptsMade: j.attemptsMade,
    failedReason: j.failedReason,
    finishedOn:   j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
  };
}

async function findTruncatedFailures(queueName) {
  const queue = jobQueue.getQueue(queueName);
  const jobs  = await queue.getFailed(0, FAILED_SCAN_CAP - 1);
  return jobs
    .filter(j => TRUNCATION_RE.test(j.failedReason || ''))
    .map(j => toRow(queueName, j));
}

// GET preview: every currently-truncated-failed job across the requested scope
async function previewTruncated(queueName) {
  const queues = resolveQueues(queueName);
  const perQueue = await Promise.all(queues.map(findTruncatedFailures));
  const jobs = perQueue.flat();
  return { count: jobs.length, jobs };
}

async function splitRetryJob(queueName, jobId) {
  const queue = jobQueue.getQueue(queueName);
  const job   = await queue.getJob(jobId);
  if (!job) throw statusError(404, 'Job not found');

  const state = await job.getState();
  if (state !== 'failed') {
    throw statusError(409, `Job is not in 'failed' state (currently '${state}') — it may already be retried/handled`);
  }

  const { pageStart, pageEnd } = job.data;
  if (typeof pageStart !== 'number' || typeof pageEnd !== 'number' || (pageEnd - pageStart) <= 1) {
    throw statusError(400, `Chunk already at 1-page floor (pages ${pageStart}-${pageEnd}) — cannot split further`);
  }

  const mid       = pageStart + Math.ceil((pageEnd - pageStart) / 2);
  const baseLabel = String(job.data.chunkIndex ?? '?');
  const halves = [
    { pageStart, pageEnd: mid, chunkIndex: `${baseLabel}a` },
    { pageStart: mid, pageEnd, chunkIndex: `${baseLabel}b` },
  ];

  const newJobs = [];
  for (const half of halves) {
    const newJob = await jobQueue.addJob(queueName, { ...job.data, ...half });
    newJobs.push({ id: newJob.id, pages: `${half.pageStart + 1}-${half.pageEnd}`, chunkIndex: half.chunkIndex });
  }

  // Remove the original only AFTER both children are successfully enqueued —
  // if addJob throws partway through, the original stays in 'failed' so no
  // page range is silently lost.
  await job.remove();

  return { originalJobId: jobId, originalRange: `${pageStart + 1}-${pageEnd}`, newJobs };
}

// POST action: re-finds truncated failures in the requested scope right now
// and split-retries every one of them. Never lets one bad row abort the rest
// — a job that raced out from under us (already handled, or hit the 1-page
// floor) just gets an `error` entry instead of failing the whole batch.
async function bulkSplitRetryTruncated(queueName) {
  const queues = resolveQueues(queueName);
  const perQueue = await Promise.all(queues.map(findTruncatedFailures));
  const targets = perQueue.flat();

  const results = [];
  for (const t of targets) {
    try {
      const result = await splitRetryJob(t.queue, t.id);
      results.push({ queue: t.queue, ...result, success: true });
    } catch (err) {
      results.push({ queue: t.queue, originalJobId: t.id, success: false, error: err.message });
    }
  }

  return {
    processed: results.length,
    succeeded: results.filter(r => r.success).length,
    failed:    results.filter(r => !r.success).length,
    results,
  };
}

module.exports = {
  KNOWN_QUEUES,
  previewTruncated,
  bulkSplitRetryTruncated,
};
