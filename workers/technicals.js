'use strict';

const { Worker } = require('bullmq');
const connection         = require('../config/redis');
const prisma             = require('../config/prisma');
const { llmStream, parseJson, logUsage, isGeminiModel } = require('../utils/workerUtils');
const { loadSkillConfig }      = require('../utils/skillConfig');
const technicalAnalysis        = require('../lib/technicalAnalysis');
const { decisionIntelligencePrompt } = require('../prompts/decision_intelligence');
const { expandTechnicalsInsight }    = require('../utils/technicalsShape');

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

    // Read the prior score BEFORE the upsert below overwrites it — this drives the
    // composite tag's direction flag (Tier/Band Rising/Falling). Null on first run.
    const prevRow = await prisma.aiInsight.findFirst({
      where: { ticker, type: 'technicals' },
      orderBy: [ { fiscal_year: 'desc' }, { quarter: 'desc' }, { updated_at: 'desc' } ],
    });
    const previousScore = prevRow?.insight?.scores?.final_score ?? null;

    const prompt = decisionIntelligencePrompt(taResult, promptTemplate, previousScore);
    console.log(`[Technicals] Prompt length for ${symbol}: ${prompt.length} chars`);

    const { text: responseText, usage } = await llmStream(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(outputSchema && { response_format: outputSchema }) },
      { vertex: isGeminiModel(model) }
    );
    logUsage('Technicals', usage);
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    // The model returns a deliberately flat/compact shape (small compiled grammar);
    // expand it back into the documented nested shape before persisting.
    const insight = expandTechnicalsInsight(parseJson(responseText), taResult, previousScore);
    await job.updateProgress(90);

    await prisma.aiInsight.upsert({
      where:  { ticker_type_fiscal_year_quarter: { ticker, type: 'technicals', fiscal_year: 'FY2024', quarter: 'Q4' } },
      create: { ticker, type: 'technicals', insight, fiscal_year: 'FY2024', quarter: 'Q4' },
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
  concurrency: 20,
  limiter: { max: 20, duration: 1000 },
});

worker.on('completed', job      => console.log(`[technicals] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[technicals] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[technicals] Worker error:', err));

console.log('Technicals analysis worker ready');

module.exports = worker;
module.exports.processTechnicalsJob = processTechnicalsJob;
