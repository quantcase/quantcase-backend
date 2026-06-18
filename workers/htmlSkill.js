'use strict';

const { Worker } = require('bullmq');
const connection = require('../config/redis');
const { runHtmlSkill } = require('../services/htmlSkill.service');

async function processHtmlSkillJob(job) {
  const { slug, ticker, fiscal_year, quarter, force } = job.data;
  console.log(`[htmlSkill] Processing job ${job.id} (skill: ${slug}, ticker: ${ticker})`);

  await job.updateProgress(10);
  const result = await runHtmlSkill({ slug, ticker, fiscal_year, quarter, force });
  await job.updateProgress(100);

  console.log(`[htmlSkill] Job ${job.id} done — cached: ${result.cached}`);
  return { slug, ticker, cached: result.cached, outputId: result.output?.id ?? null };
}

const worker = new Worker('html_skill', processHtmlSkillJob, {
  connection,
  concurrency: 10,
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', (job)      => console.log(`[htmlSkill] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[htmlSkill] Job ${job.id} failed:`, err.message));
worker.on('error',     (err)      => console.error('[htmlSkill] Worker error:', err));

console.log('HtmlSkill worker ready');

module.exports = worker;
