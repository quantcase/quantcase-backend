'use strict';

const { Worker }     = require('bullmq');
const connection     = require('../config/redis');
const prisma         = require('../config/prisma');
const { llmStream, parseJson }             = require('../utils/workerUtils');
const { loadSkillConfig }                  = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { getIdentity }                      = require('../lib/peerIdentity');
const { overviewSynthesisPrompt }          = require('../prompts/overview_synthesis');
const { OVERVIEW_SOURCE_TYPES }            = require('../services/overviewSynthesis.service');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOverviewSynthesisJob(job) {
  const { ticker, forceRefresh } = job.data;
  console.log(`[OverviewSynthesis] Job ${job.id} (ticker: ${ticker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId: `overview_${ticker}`, type: 'overview_synthesis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(10);

    // ── 1. Fetch all source insights ─────────────────────────────────────────
    const sourceRows = await prisma.aiInsight.findMany({
      where: { ticker, type: { in: OVERVIEW_SOURCE_TYPES } },
    });

    if (sourceRows.length === 0) {
      throw new Error(`No source insights found for ${ticker}. Run management/opportunity/deal/technicals jobs first.`);
    }

    // Map type → row
    const rowByType = Object.fromEntries(sourceRows.map(r => [r.type, r]));

    // ── 2. Cache check: hash over source updated_at timestamps ───────────────
    const hashInput = OVERVIEW_SOURCE_TYPES
      .map(t => `${t}:${rowByType[t]?.updated_at?.toISOString() ?? 'missing'}`)
      .join('|');
    const sourceHash = computeSourceHash(hashInput);

    if (!forceRefresh) {
      const cached = await prisma.aiInsight.findFirst({
        where: { ticker, type: 'overview', lens_scores_hash: sourceHash },
      });
      if (cached) {
        console.log(`[OverviewSynthesis] Cache hit for ${ticker} — skipping LLM`);
        await prisma.job.update({
          where: { bullmqId: job.id },
          data:  { status: 'completed', result: { ticker, cached: true } },
        });
        await job.updateProgress(100);
        return { cached: true, ticker };
      }
    }
    await job.updateProgress(25);

    // ── 3. Resolve insight JSON payloads (the actual LLM output stored in DB) ─
    const insights = Object.fromEntries(
      OVERVIEW_SOURCE_TYPES.map(t => [t, rowByType[t]?.insight ?? null])
    );

    // ── 4. Company identity from osc_identity.csv ─────────────────────────────
    const identity = getIdentity(ticker);
    await job.updateProgress(35);

    // ── 5. Load skill config + build prompt ───────────────────────────────────
    const { model, maxTokens, promptTemplate, updatedAt } = await loadSkillConfig('overview-synthesis');
    const promptV  = computePromptVersion('overview-synthesis', updatedAt);
    const prompt   = overviewSynthesisPrompt(identity, insights, promptTemplate);
    console.log(`[OverviewSynthesis] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(45);

    // ── 6. LLM call ───────────────────────────────────────────────────────────
    console.log('[OverviewSynthesis] Calling LLM...');
    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const result = parseJson(responseText);
    await job.updateProgress(90);

    // ── 7. Upsert into ai_insights with type="overview" ───────────────────────
    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: 'overview' } },
      update: { insight: result, lens_scores_hash: sourceHash, prompt_v: promptV },
      create: { ticker, type: 'overview', insight: result, lens_scores_hash: sourceHash, prompt_v: promptV },
    });
    console.log(`[OverviewSynthesis] ai_insights upserted for ${ticker}/overview`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { ticker, type: 'overview' } },
    });

    await job.updateProgress(100);
    console.log(`[OverviewSynthesis] Job ${job.id} completed`);
    return { ticker, type: 'overview', result };

  } catch (error) {
    console.error(`[OverviewSynthesis] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: `overview_${ticker}`, type: 'overview_synthesis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error('[OverviewSynthesis] Failed to update job in DB:', dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('overview_synthesis', processOverviewSynthesisJob, {
  connection,
  concurrency: 25,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[overview-synthesis] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[overview-synthesis] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[overview-synthesis] Worker error:', err));

console.log('Overview synthesis worker ready');

module.exports = worker;
