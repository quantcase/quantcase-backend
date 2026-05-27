'use strict';

const { Worker } = require('bullmq');
const connection = require('../config/redis');
const { composeLens } = require('../services/lensComposer');

async function processLensComputationJob(job) {
  const { callId, lensSlug } = job.data;
  console.log(`[lensComputation] Processing job ${job.id} (callId: ${callId}, lens: ${lensSlug})`);

  await job.updateProgress(10);
  const result = await composeLens(callId, lensSlug);
  await job.updateProgress(100);

  console.log(`[lensComputation] Job ${job.id} done — ${lensSlug} score: ${result?.score ?? 'n/a'}`);
  return { callId, lensSlug, score: result?.score ?? null };
}

const worker = new Worker('lens_computation', processLensComputationJob, {
  connection,
  concurrency: 25,
  limiter: { max: 30, duration: 1000 },
});

worker.on('completed', (job)      => console.log(`[lensComputation] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[lensComputation] Job ${job.id} failed:`, err.message));
worker.on('error',     (err)      => console.error('[lensComputation] Worker error:', err));

console.log('Lens computation worker ready');

module.exports = worker;
