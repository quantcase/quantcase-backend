'use strict';

const { Worker }     = require('bullmq');
const connection     = require('../config/redis');
const prisma         = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { loadSkillConfig }      = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { composeAllLenses, getLensScores } = require('../services/lensComposer');
const { aiInsightSynthesisPrompt }         = require('../prompts/ai_insight_synthesis');
const { INSIGHT_LENSES }                   = require('../lib/insightLenses');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processAiInsightSynthesisJob(job) {
  const { callId, insightType, forceRefresh } = job.data;
  const ticker = callId.includes('_FY') ? callId.slice(0, callId.indexOf('_FY')) : callId;
  console.log(`[AiInsightSynthesis] Job ${job.id} (callId: ${callId}, type: ${insightType})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: insightType || 'ai_insight_synthesis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(10);

    // ── 1. Ensure fresh lens scores are available ─────────────────────────
    // Only operate on the lens slugs relevant to this insightType
    const relevantSlugs = INSIGHT_LENSES[insightType] ?? [];
    if (relevantSlugs.length === 0) throw new Error(`Unknown insightType: ${insightType}`);

    let allLensScores = await getLensScores(callId);
    const hasStale = await prisma.lensScore.count({ where: { call_id: callId, is_stale: true } });

    if (allLensScores.length === 0 || hasStale > 0) {
      console.log(`[AiInsightSynthesis] Composing all lenses for ${callId}...`);
      await composeAllLenses(callId);
      allLensScores = await getLensScores(callId);
    }

    // Filter to only the lenses relevant for this insightType
    const lensScores = allLensScores.filter(ls => relevantSlugs.includes(ls.lens_slug));

    if (lensScores.length === 0) {
      throw new Error(`No lens scores for ${insightType} lenses in ${callId}. Run lens compute first.`);
    }
    await job.updateProgress(30);

    // ── 2. Check cache by hashing the current lens scores ────────────────
    const scoreSummary = lensScores
      .sort((a, b) => a.lens_slug.localeCompare(b.lens_slug))
      .map(ls => `${ls.lens_slug}:${ls.z_score.toFixed(6)}`)
      .join('|');
    const lensScoresHash = computeSourceHash(scoreSummary);

    if (!forceRefresh) {
      const cached = await prisma.aiInsight.findFirst({
        where: { ticker, type: insightType, lens_scores_hash: lensScoresHash },
      });
      if (cached) {
        console.log(`[AiInsightSynthesis] Cache hit for ${ticker}/${insightType} — skipping LLM`);
        await prisma.job.update({
          where: { bullmqId: job.id },
          data:  { status: 'completed', result: { callId, ticker, insightType, cached: true } },
        });
        await job.updateProgress(100);
        return { cached: true, ticker, insightType };
      }
    }
    await job.updateProgress(40);

    // ── 3. Load skill + build prompt ──────────────────────────────────────
    const { model, maxTokens, promptTemplate, updatedAt } = await loadSkillConfig('ai-insight-synthesis');
    const promptV = computePromptVersion('ai-insight-synthesis', updatedAt);
    const prompt  = aiInsightSynthesisPrompt(insightType, lensScores, promptTemplate);
    console.log(`[AiInsightSynthesis] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(50);

    // ── 4. LLM call ───────────────────────────────────────────────────────
    console.log('[AiInsightSynthesis] Calling LLM...');
    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const result = parseJson(responseText);
    await job.updateProgress(90);

    // ── 5. Upsert into ai_insights (existing table, now with lineage cols) ─
    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: insightType } },
      update: { insight: result, lens_scores_hash: lensScoresHash, prompt_v: promptV },
      create: { ticker, type: insightType, insight: result, lens_scores_hash: lensScoresHash, prompt_v: promptV },
    });
    console.log(`[AiInsightSynthesis] ai_insights upserted for ${ticker}/${insightType}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId, ticker, insightType } },
    });

    await job.updateProgress(100);
    console.log(`[AiInsightSynthesis] Job ${job.id} completed`);
    return { ticker, insightType, result };

  } catch (error) {
    console.error(`[AiInsightSynthesis] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: insightType || 'ai_insight_synthesis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error(`[AiInsightSynthesis] Failed to update job in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('ai_insight_synthesis', processAiInsightSynthesisJob, {
  connection,
  concurrency: 25,
  limiter: { max: 25, duration: 1000 },
});

worker.on('completed', job       => console.log(`[ai-insight-synthesis] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[ai-insight-synthesis] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[ai-insight-synthesis] Worker error:', err));

console.log('AI Insight Synthesis worker ready');

module.exports = worker;
