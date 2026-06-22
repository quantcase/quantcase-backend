'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const connection = require('../config/redis');
const { runHtmlSkill, runHtmlSkillPreview } = require('../services/htmlSkill.service');

function rethrowIfUnrecoverable(err) {
  const status = err?.status ?? err?.response?.status;
  const body   = err?.error ?? err?.response?.data;
  const code   = body?.code ?? body?.error?.code;
  const msg    = err?.message ?? '';

  const isContextLength =
    (status === 400 && msg.toLowerCase().includes('context length')) ||
    code === 'context_length_exceeded';

  if (isContextLength) {
    // Preserve the original message so the frontend can display it verbatim.
    // UnrecoverableError tells BullMQ to move to failed immediately without retrying.
    const ure = new UnrecoverableError(msg);
    ure.cause = err;
    throw ure;
  }
}

async function processHtmlSkillJob(job) {
  const {
    slug, ticker, fiscal_year, quarter, force,
    transcript_signal_types, ppt_signal_types, annual_report_signal_types,
    max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
  } = job.data;
  console.log(`[htmlSkill] Processing job ${job.id} (skill: ${slug}, ticker: ${ticker})`);

  try {
    await job.updateProgress(10);
    const result = await runHtmlSkill({
      slug, ticker, fiscal_year, quarter, force,
      transcript_signal_types, ppt_signal_types, annual_report_signal_types,
      max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
    });
    await job.updateProgress(100);

    console.log(`[htmlSkill] Job ${job.id} done — cached: ${result.cached}`);
    return { slug, ticker, cached: result.cached, outputId: result.output?.id ?? null };
  } catch (err) {
    rethrowIfUnrecoverable(err);
    throw err;
  }
}

const worker = new Worker('html_skill', processHtmlSkillJob, {
  connection,
  concurrency: 10,
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', (job)      => console.log(`[htmlSkill] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[htmlSkill] Job ${job.id} failed:`, err.message));
worker.on('error',     (err)      => console.error('[htmlSkill] Worker error:', err));

async function processHtmlSkillPreviewJob(job) {
  const { ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, force } = job.data;
  console.log(`[htmlSkillPreview] Processing job ${job.id} (ticker: ${ticker})`);

  try {
    await job.updateProgress(10);
    const result = await runHtmlSkillPreview({ ticker, skill_prompt, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, force });
    await job.updateProgress(100);

    console.log(`[htmlSkillPreview] Job ${job.id} done — cached: ${result.cached}`);
    return { ticker, cached: result.cached, outputId: result.output?.id ?? null };
  } catch (err) {
    rethrowIfUnrecoverable(err);
    throw err;
  }
}

const previewWorker = new Worker('html_skill_preview', processHtmlSkillPreviewJob, {
  connection,
  concurrency: 10,
  limiter: { max: 10, duration: 1000 },
});

previewWorker.on('completed', (job)      => console.log(`[htmlSkillPreview] Job ${job.id} completed`));
previewWorker.on('failed',    (job, err) => console.error(`[htmlSkillPreview] Job ${job.id} failed:`, err.message));
previewWorker.on('error',     (err)      => console.error('[htmlSkillPreview] Worker error:', err));

console.log('HtmlSkill worker ready');

module.exports = { worker, previewWorker };
