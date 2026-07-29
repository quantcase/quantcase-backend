'use strict';

const { triggerDailyBatch } = require('../../services/prowess/prowessBatchOrchestrator.service');

// Submits the checked-in daily_ohlcv.bt template via SendBatch (same call as
// POST /admin/prowess/batch/daily/run). Submission only -- resolving the
// token (GetBatch -> ingest) happens separately, either via the admin
// frontend's per-batch refresh (POST /admin/prowess/batch/:token/check) or
// the prowess_batch_poll job if that's enabled.
async function run(_config = {}) {
  const { row } = await triggerDailyBatch();
  console.log(`[prowess-daily-batch] submitted token=${row.token} status=${row.status}`);
  return { token: row.token, status: row.status };
}

module.exports = { run };
