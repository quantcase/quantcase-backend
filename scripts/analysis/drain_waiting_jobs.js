#!/usr/bin/env node
'use strict';

/**
 * Drain all WAITING jobs from the BullMQ summarization queue.
 * Safe: leaves active/completed/failed jobs untouched.
 *
 * Usage:
 *   node scripts/analysis/drain_waiting_jobs.js
 *   node scripts/analysis/drain_waiting_jobs.js --dry-run
 */

require('dotenv').config();
const jobQueue = require('../../lib/jobQueue');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const q = jobQueue.getQueue('summarization');

  const before = await q.getJobCounts('waiting', 'active', 'completed', 'failed');
  console.log('BullMQ counts before:', JSON.stringify(before));

  if (dryRun) {
    console.log(`\n[DRY RUN] Would drain ${before.waiting} waiting jobs. Exiting.`);
    return;
  }

  console.log(`\nDraining ${before.waiting} waiting jobs...`);
  await q.drain(); // removes all waiting (not active) jobs
  console.log('Done draining.');

  const after = await q.getJobCounts('waiting', 'active', 'completed', 'failed');
  console.log('BullMQ counts after: ', JSON.stringify(after));
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => jobQueue.close());
