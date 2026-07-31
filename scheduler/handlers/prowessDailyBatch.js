'use strict';

const { triggerDailyBatch, pollAndResolve } = require('../../services/prowess/prowessBatchOrchestrator.service');

const POLL_INTERVAL_MS = 15000;
const MAX_WAIT_MS = 8 * 60 * 1000; // matches the timeout used by the manual qc_*.js test scripts this replaced

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Submits the checked-in daily_ohlcv.bt template via SendBatch (same call as
// POST /admin/prowess/batch/daily/run), then polls GetBatch in-process until
// it resolves (or MAX_WAIT_MS elapses) and ingests it -- all inside this one
// job run. This is a single async chain on this job's own timer; it does not
// block other scheduler jobs (each has its own independent setTimeout, see
// scheduler/index.js#fireJob). Deliberately not a separate always-on
// prowess_batch_poll cron -- one bounded wait right after submission covers
// the normal case, and the admin frontend's per-batch refresh remains the
// fallback if CMIE is unusually slow and this still leaves it pending.
async function run(_config = {}) {
  const { row } = await triggerDailyBatch();
  const token = row.token;
  console.log(`[prowess-daily-batch] submitted token=${token}, polling for resolution...`);

  const start = Date.now();
  let resolved = row;
  while (Date.now() - start < MAX_WAIT_MS) {
    resolved = await pollAndResolve(token);
    if (resolved.status !== 'pending') break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (resolved.status === 'pending') {
    console.warn(`[prowess-daily-batch] token=${token} still pending after ${MAX_WAIT_MS}ms -- leaving for manual resolution via admin refresh`);
    return { token, status: 'pending' };
  }
  if (resolved.status === 'failed') {
    throw new Error(`Prowess batch ${token} failed: ${resolved.error}`);
  }

  const totalRowsIngested = resolved.result?.totalRowsIngested ?? 0;
  console.log(`[prowess-daily-batch] token=${token} completed, ingested ${totalRowsIngested} rows`);
  return { records_processed: totalRowsIngested, token, status: resolved.status, files: resolved.result?.files };
}

module.exports = { run };
