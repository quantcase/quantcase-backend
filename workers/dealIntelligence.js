'use strict';

const { Worker }               = require('bullmq');
const connection               = require('../config/redis');
const prisma                   = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { dealIntelligencePrompt } = require('../prompts/deal_intelligence');
const { getDealResult }        = require('../services/db/deal.db');
const { loadSkillConfig }      = require('../utils/skillConfig');

async function getRecentSummaries(ticker) {
  const rows = await prisma.summaryNew.findMany({
    where:   { callId: { startsWith: ticker + '_' } },
    orderBy: { createdAt: 'desc' },
    take:    3,
    select:  { callId: true, governanceSignals: true, tone: true, confidence: true },
  });
  return rows.reverse();
}

async function processDealIntelligenceJob(job) {
  const { callId, ticker, rootJobBullmqId } = job.data;
  console.log(`Processing DealIntelligence job ${job.id} (callId: ${callId}, ticker: ${ticker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: 'deal_intelligence', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    // Load deal-analysis result (must already exist)
    const dealRecord = await getDealResult(callId);
    if (!dealRecord) throw new Error(`No deal-analysis result found for callId: ${callId}. Run deal-analysis first.`);
    await job.updateProgress(20);

    const recentSummaries = await getRecentSummaries(ticker);
    console.log(`[DealIntelligence] Recent summaries for ${ticker}: ${recentSummaries.length}`);
    await job.updateProgress(35);

    const { model, maxTokens, promptTemplate } = await loadSkillConfig('deal-intelligence');
    const prompt = dealIntelligencePrompt(dealRecord.result, dealRecord.inputs, recentSummaries, promptTemplate);
    console.log(`[DealIntelligence] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(45);

    console.log('[DealIntelligence] Calling LLM API...');
    const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    await job.updateProgress(80);

    if (!responseText) throw new Error('Empty response from LLM');

    const intelligenceResult = parseJson(responseText);
    await job.updateProgress(90);

    // Upsert into DealResult.result by merging deal_intelligence alongside existing scenarios
    await prisma.dealResult.update({
      where: { callId },
      data:  { result: { ...dealRecord.result, deal_intelligence: intelligenceResult?.deal_intelligence ?? intelligenceResult } },
    });
    console.log(`[DealIntelligence] Result saved for callId: ${callId}`);

    // Mark this job completed
    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId } },
    });

    // Mark the root deal-analysis job completed now that the full chain is done
    if (rootJobBullmqId) {
      await prisma.job.update({
        where: { bullmqId: rootJobBullmqId },
        data:  { status: 'completed', result: { callId, scenariosGenerated: true, intelligenceGenerated: true } },
      }).catch(err => console.warn(`[DealIntelligence] Could not mark root job completed: ${err.message}`));
    }

    await job.updateProgress(100);
    console.log(`[DealIntelligence] Job ${job.id} completed`);
    return { result: intelligenceResult };

  } catch (error) {
    console.error(`[DealIntelligence] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: 'deal_intelligence', status: 'failed', bullmqId: job.id, error: error.message },
      });
      // Also mark the root job failed so the client isn't left polling forever
      if (rootJobBullmqId) {
        await prisma.job.update({
          where: { bullmqId: rootJobBullmqId },
          data:  { status: 'failed', error: `deal-intelligence failed: ${error.message}` },
        }).catch(() => {});
      }
    } catch (dbErr) {
      console.error(`[DealIntelligence] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

const worker = new Worker('deal_intelligence', processDealIntelligenceJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[deal-intelligence] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[deal-intelligence] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[deal-intelligence] Worker error:', err));

console.log('Deal intelligence worker ready');

module.exports = worker;
