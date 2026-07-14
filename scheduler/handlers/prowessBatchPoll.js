'use strict';

const { listPending } = require('../../services/prowess/prowessBatchRequests.service');
const { pollAndResolve } = require('../../services/prowess/prowessBatchOrchestrator.service');

// Polls GetBatch for every still-pending ProwessBatchRequest row. Cheap call,
// safe to retry on every cron tick — unlike SendBatch this has no "don't
// auto-retry" constraint. See prowessBatchOrchestrator.service.js for how a
// response is classified pending/completed/failed.
async function run(_config = {}) {
  const pending = await listPending();
  let completed = 0, failed = 0, stillPending = 0;

  for (const { token } of pending) {
    const row = await pollAndResolve(token);
    if (row.status === 'completed') completed++;
    else if (row.status === 'failed') failed++;
    else stillPending++;
  }

  console.log(`[prowess-batch-poll] checked=${pending.length} completed=${completed} failed=${failed} pending=${stillPending}`);
  return { checked: pending.length, completed, failed, still_pending: stillPending };
}

module.exports = { run };
