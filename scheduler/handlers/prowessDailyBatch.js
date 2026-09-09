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

  // Invalidate daily caches after new market data is ingested
  if (totalRowsIngested > 0) {
    try {
      const cache = require('../../lib/cache');
      const deletedCounts = await Promise.all([
        cache.delByPattern('qc:stock:*:info'),
        cache.delByPattern('qc:stock:*:prices*'),
        cache.delByPattern('qc:stock:*:wyckoff*'),
        cache.delByPattern('qc:stock:*:peers'),
        cache.delByPattern('qc:basket:*'),
        cache.delByPattern('qc:tickers:*'),
        cache.del('qc:market:indices'),
      ]);
      const totalKeys = deletedCounts.reduce((s, c) => s + (typeof c === 'number' ? c : 0), 0);
      console.log(`[prowess-daily-batch] Invalidate daily caches completed (${totalKeys} keys cleared)`);
    } catch (cacheErr) {
      console.warn('[prowess-daily-batch] Cache invalidation warning:', cacheErr.message);
    }
  }

  // On Tuesdays (2) and Thursdays (4) in Asia/Kolkata, auto-trigger technicals batch
  const istDateStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const istDay = new Date(istDateStr).getDay();
  const isTargetDay = istDay === 2 || istDay === 4;

  if (_config.auto_trigger_technicals !== false && isTargetDay) {
    try {
      console.log(`[prowess-daily-batch] Auto-triggering technicals analysis for batch ${token} (IST day=${istDay})...`);
      const technicalsHandler = require('./technicalsDailyBatch');
      technicalsHandler.run({ batch_token: token, force: true }).catch((err) => {
        console.error('[prowess-daily-batch] Background technicals batch error:', err.message);
      });
    } catch (err) {
      console.error('[prowess-daily-batch] Failed to dispatch technicals batch:', err.message);
    }
  }

  return { records_processed: totalRowsIngested, token, status: resolved.status, files: resolved.result?.files };
}

module.exports = { run };
