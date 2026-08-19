'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const connection = require('../config/redis');
const { runIncrementalHtmlSkill } = require('../services/htmlIncrementalSkill.service');

function rethrowIfUnrecoverable(err) {
  const status = err?.status ?? err?.response?.status;
  const body   = err?.error ?? err?.response?.data;
  const code   = body?.code ?? body?.error?.code;
  const msg    = err?.message ?? '';

  const isContextLength =
    (status === 400 && msg.toLowerCase().includes('context length')) ||
    code === 'context_length_exceeded';

  const isStructuralError = status === 400 || status === 404;

  if (isContextLength || isStructuralError) {
    const ure = new UnrecoverableError(msg);
    ure.cause = err;
    throw ure;
  }
}

async function processHtmlIncrementalSkillJob(job) {
  const { slug, ticker, callId, force, historic, configKey } = job.data;
  console.log(`[htmlIncrementalSkill] Processing job ${job.id} (skill: ${slug}, ticker: ${ticker}, callId: ${callId}, historic: ${!!historic}, configKey: ${configKey ?? 'none'})`);

  try {
    await job.updateProgress(10);
    const result = await runIncrementalHtmlSkill({ slug, ticker, callId, force, historic, configKey }, job);
    await job.updateProgress(100);

    console.log(`[htmlIncrementalSkill] Job ${job.id} done — cached: ${result.cached}`);
    return { slug, ticker, callId, cached: result.cached, outputId: result.output?.id ?? null };
  } catch (err) {
    rethrowIfUnrecoverable(err);
    throw err;
  }
}

const worker = new Worker('html_skill_incremental', processHtmlIncrementalSkillJob, {
  connection,
  concurrency: 10,
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', (job)      => console.log(`[htmlIncrementalSkill] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[htmlIncrementalSkill] Job ${job.id} failed:`, err.message));
worker.on('error',     (err)      => console.error('[htmlIncrementalSkill] Worker error:', err));

console.log('HtmlIncrementalSkill worker ready');

module.exports = worker;
