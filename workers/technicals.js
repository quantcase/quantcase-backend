'use strict';

const { Worker } = require('bullmq');
const connection         = require('../config/redis');
const prisma             = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { loadSkillConfig }      = require('../utils/skillConfig');
const technicalAnalysis        = require('../lib/technicalAnalysis');
const { decisionIntelligencePrompt } = require('../prompts/decision_intelligence');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processTechnicalsJob(job) {
  const { symbol } = job.data;
  const ticker = symbol;

  console.log(`Processing Technicals job ${job.id} (symbol: ${symbol})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId: `technicals_${symbol}`, type: 'technicals_analysis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    // Compute full TA result
    const taResult = await technicalAnalysis.analyze(symbol);
    await job.updateProgress(30);

    if (!taResult?.ruleEngine) {
      throw new Error(`No ruleEngine data for symbol ${symbol}`);
    }

    const { model, maxTokens, outputSchema, promptTemplate } = await loadSkillConfig('technical-intelligence');
    await job.updateProgress(40);

    const prompt = decisionIntelligencePrompt(taResult, promptTemplate);
    console.log(`[Technicals] Prompt length for ${symbol}: ${prompt.length} chars`);

    const responseText = await llmStream(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
      outputSchema,
    );
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const insight = parseJson(responseText);
    await job.updateProgress(90);

    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: 'technicals' } },
      create: { ticker, type: 'technicals', insight },
      update: { insight, updated_at: new Date() },
    });
    console.log(`[Technicals] Decision intelligence saved for ${symbol}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { symbol, keys: Object.keys(insight) } },
    });

    await job.updateProgress(100);
    console.log(`[Technicals] Job ${job.id} completed`);
    return { symbol, keys: Object.keys(insight) };

  } catch (error) {
    console.error(`[Technicals] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: `technicals_${symbol}`, type: 'technicals_analysis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error(`[Technicals] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('technicals_analysis', processTechnicalsJob, {
  connection,
  concurrency: 3,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job      => console.log(`[technicals] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[technicals] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[technicals] Worker error:', err));

console.log('Technicals analysis worker ready');

module.exports = worker;
