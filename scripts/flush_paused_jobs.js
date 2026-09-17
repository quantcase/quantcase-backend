#!/usr/bin/env node
'use strict';

/**
 * Flush all PAUSED jobs from BullMQ (defaults to 'html_skill_incremental').
 * Safe: leaves active, completed, and failed jobs untouched.
 *
 * Usage on the VM:
 *   node scripts/flush_paused_jobs.js
 *   node scripts/flush_paused_jobs.js --dry-run
 *   node scripts/flush_paused_jobs.js --queue html_skill_incremental
 *   node scripts/flush_paused_jobs.js --resume               # Flush paused jobs and resume queue
 *   node scripts/flush_paused_jobs.js --drain                # Also drain any waiting jobs
 *   node scripts/flush_paused_jobs.js --redis-host 127.0.0.1 --redis-port 6379
 */

const path = require('path');

// CLI overrides for Redis connection
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--redis-host' && process.argv[i + 1]) {
    process.env.REDIS_HOST = process.argv[++i];
  } else if (process.argv[i] === '--redis-port' && process.argv[i + 1]) {
    process.env.REDIS_PORT = process.argv[++i];
  } else if (process.argv[i] === '--redis-password' && process.argv[i + 1]) {
    process.env.REDIS_PASSWORD = process.argv[++i];
  }
}

// Load environment variables if available
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  require('dotenv').config();
} catch (_) {}

// Parse CLI flags
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const resumeAfter = args.includes('--resume');
const useDrain = args.includes('--drain');

// Determine target queue name
let queueName = 'html_skill_incremental';
const queueIdx = args.indexOf('--queue');
if (queueIdx !== -1 && args[queueIdx + 1]) {
  queueName = args[queueIdx + 1];
} else {
  const positional = args.find((arg) => !arg.startsWith('--'));
  if (positional) {
    queueName = positional;
  }
}

// Support both existing quantcase lib/jobQueue and standalone execution
let getQueue;
let closeConnection;

try {
  const jobQueue = require('../lib/jobQueue');
  getQueue = (name) => jobQueue.getQueue(name);
  closeConnection = async () => jobQueue.close();
} catch (_) {
  const { Queue } = require('bullmq');
  const Redis = require('ioredis');
  const connection = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
  const queues = {};
  getQueue = (name) => {
    if (!queues[name]) {
      queues[name] = new Queue(name, { connection });
    }
    return queues[name];
  };
  closeConnection = async () => {
    for (const k in queues) {
      await queues[k].close();
    }
    await connection.quit();
  };
}

async function main() {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || 6379;
  console.log(`[BullMQ Flush] Target queue : "${queueName}"`);
  console.log(`[BullMQ Flush] Redis host   : ${host}:${port}`);

  const q = getQueue(queueName);

  const isPaused = await q.isPaused();
  const before = await q.getJobCounts('paused', 'waiting', 'active', 'completed', 'failed', 'delayed');

  console.log(`\n--- Queue Status (Before) ---`);
  console.log(`Queue state : ${isPaused ? 'PAUSED' : 'RUNNING (active)'}`);
  console.log(`Job counts  : ${JSON.stringify(before, null, 2)}`);

  if (before.paused === 0 && (!useDrain || before.waiting === 0)) {
    console.log(`\nNo paused jobs found in queue "${queueName}". Nothing to flush.`);
    if (isPaused && resumeAfter) {
      if (dryRun) {
        console.log(`[DRY RUN] Would resume queue "${queueName}".`);
      } else {
        console.log(`Resuming queue "${queueName}"...`);
        await q.resume();
        console.log(`Queue "${queueName}" resumed.`);
      }
    }
    return;
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would flush ${before.paused} paused job(s) from "${queueName}".`);
    if (useDrain) {
      console.log(`[DRY RUN] Would also drain ${before.waiting} waiting job(s).`);
    }
    if (resumeAfter) {
      console.log(`[DRY RUN] Would resume queue "${queueName}" after flushing.`);
    }
    console.log(`Exiting without making changes.`);
    return;
  }

  console.log(`\nFlushing ${before.paused} paused job(s)...`);

  // 1. Clean paused jobs using BullMQ clean (grace = 0)
  const cleanedIds = await q.clean(0, 0, 'paused');
  console.log(`Cleaned ${cleanedIds.length} paused job(s) via queue.clean(0, 0, 'paused').`);

  // 2. Fallback check: if any paused jobs remain, fetch and remove them
  const remainingPaused = await q.getJobs(['paused'], 0, 5000);
  if (remainingPaused.length > 0) {
    console.log(`Removing ${remainingPaused.length} remaining paused job(s) individually...`);
    for (const job of remainingPaused) {
      try {
        await job.remove();
      } catch (err) {
        console.warn(`Could not remove job ${job.id}: ${err.message}`);
      }
    }
  }

  // 3. If --drain was passed, drain waiting & paused lists
  if (useDrain) {
    console.log(`Draining queue (clears waiting and paused jobs)...`);
    await q.drain();
  }

  // 4. Optionally resume queue if requested
  if (resumeAfter) {
    console.log(`Resuming queue "${queueName}"...`);
    await q.resume();
    console.log(`Queue "${queueName}" is now RESUMED.`);
  }

  console.log('Flush complete.');

  const isPausedAfter = await q.isPaused();
  const after = await q.getJobCounts('paused', 'waiting', 'active', 'completed', 'failed', 'delayed');

  console.log(`\n--- Queue Status (After) ---`);
  console.log(`Queue state : ${isPausedAfter ? 'PAUSED' : 'RUNNING (active)'}`);
  console.log(`Job counts  : ${JSON.stringify(after, null, 2)}`);
}

main()
  .catch((err) => {
    console.error('[BullMQ Flush] Fatal error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await closeConnection();
    } catch (_) {}
  });
