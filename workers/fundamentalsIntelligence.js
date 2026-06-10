'use strict';

const { Worker } = require('bullmq');
const connection         = require('../config/redis');
const prisma             = require('../config/prisma');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { loadSkillConfig }      = require('../utils/skillConfig');
const financials               = require('../lib/financials');
const { fundamentalsIntelligencePrompt } = require('../prompts/fundamentals_intelligence');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processFundamentalsJob(job) {
  const { symbol } = job.data;
  const ticker = symbol;

  console.log(`Processing Fundamentals Intelligence job ${job.id} (symbol: ${symbol})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId: `fundamentals_${symbol}`, type: 'fundamentals_analysis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    const finResult = await financials.analyze(symbol);
    await job.updateProgress(30);

    if (!finResult?.standardized) {
      throw new Error(`No standardized financials data for symbol ${symbol}`);
    }

    const { model, maxTokens, promptTemplate } = await loadSkillConfig('fundamentals-intelligence');
    await job.updateProgress(40);

    const prompt = fundamentalsIntelligencePrompt(symbol, finResult, promptTemplate);
    console.log(`[Fundamentals] Prompt length for ${symbol}: ${prompt.length} chars`);

    const { text: responseText, usage } = await llmStream(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
    );
    logUsage('Fundamentals', usage);
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const insight = parseJson(responseText);
    await job.updateProgress(90);

    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: 'fundamentals' } },
      create: { ticker, type: 'fundamentals', insight },
      update: { insight, updated_at: new Date() },
    });
    console.log(`[Fundamentals] Intelligence saved for ${symbol}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { symbol, keys: Object.keys(insight) } },
    });

    await job.updateProgress(100);
    console.log(`[Fundamentals] Job ${job.id} completed`);
    return { symbol, keys: Object.keys(insight) };

  } catch (error) {
    console.error(`[Fundamentals] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: `fundamentals_${symbol}`, type: 'fundamentals_analysis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error(`[Fundamentals] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('fundamentals_analysis', processFundamentalsJob, {
  connection,
  concurrency: 3,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job      => console.log(`[fundamentals] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[fundamentals] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[fundamentals] Worker error:', err));

console.log('Fundamentals intelligence worker ready');

module.exports = worker;
