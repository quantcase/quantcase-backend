const { Worker } = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { dealAnalysisPrompt }    = require('../prompts/deal_analysis');
const { upsertDealResult }      = require('../services/db/deal.db');
const { FinHelper }             = require('../utils/finHelper');
const { isBFSI }                = require('../utils/industryClassifier');
const { loadSkillConfig }       = require('../utils/skillConfig');
const { enqueueSkillJob }       = require('../services/plugins.service');

/** Latest non-null value from a time-series array, or null. */
const _latest = (series) =>
  Array.isArray(series) ? series.filter(s => s.value != null).at(-1)?.value ?? null : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getRecentSummaries(ticker) {
  const rows = await prisma.summaryNew.findMany({
    where:   { callId: { startsWith: ticker + '_' } },
    orderBy: { createdAt: 'desc' },
    take:    3,
    select:  { callId: true, governanceSignals: true, tone: true, confidence: true }
  });
  return rows.reverse();
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processDealJob(job) {
  const { callId, ticker, industry, companyName, stockEps, stockPe, industryEps, industryPe, stockRev, stockRoce, industryRev } = job.data;
  console.log(`Processing Deal job ${job.id} (callId: ${callId}, ticker: ${ticker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: 'deal_analysis', status: 'processing', bullmqId: job.id }
    });
    await job.updateProgress(5);

    const cmp = null;
    await job.updateProgress(20);

    const recentSummaries = await getRecentSummaries(ticker);
    console.log(`[Deal] Recent summaries for ${ticker}: ${recentSummaries.length}`);
    await job.updateProgress(35);

    // ── Derived KPI metrics (computed from kpi_values source KPIs) ─────────────
    let ebitMargin = null, roe = null, cashConversionPct = null;
    try {
      const helper = new FinHelper(prisma);
      const bfsi   = isBFSI(industry);
      const [derivedBatch, patSeries] = await Promise.all([
        helper.getDerivedKpiBatch(ticker, bfsi),
        helper.getTimeSeries(ticker, 'PAT'),
      ]);
      ebitMargin = _latest(derivedBatch.EBIT_MARGIN);
      roe        = _latest(derivedBatch.ROE);
      const fcf  = _latest(derivedBatch.FCF);
      const pat  = _latest(patSeries);
      if (fcf != null && pat != null && pat !== 0) {
        cashConversionPct = parseFloat((fcf / pat * 100).toFixed(1));
      }
      console.log(`[Deal] Derived — ebitMargin=${ebitMargin}, roe=${roe}, fcf=${fcf}, pat=${pat}, cashConv=${cashConversionPct}`);
    } catch (err) {
      console.warn(`[Deal] Could not compute derived KPIs for ${ticker}: ${err.message}`);
    }

    const { model, maxTokens, promptTemplate } = await loadSkillConfig('deal-analysis');
    const prompt = dealAnalysisPrompt(ticker, companyName, industry, cmp, stockEps, stockPe, industryEps, industryPe, recentSummaries, stockRev, stockRoce, ebitMargin, roe, cashConversionPct, industryRev, promptTemplate);
    console.log(`[Deal] Prompt length: ${prompt.length} chars`);

    await job.updateProgress(45);

    console.log('[Deal] Calling LLM API...');
    const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    await job.updateProgress(80);

    if (!responseText) throw new Error('Empty response from LLM');

    const dealResult = parseJson(responseText);
    await job.updateProgress(90);

    await upsertDealResult(callId, ticker, dealResult, { cmp, stockEps, stockPe, industryEps, industryPe }, prisma);
    console.log(`[Deal] Result saved for callId: ${callId}`);

    // Chain to next skill in the deal plugin (deal-intelligence)
    const { pluginSlug, skillOrder } = job.data;
    let chained = false;
    if (pluginSlug && skillOrder != null) {
      const nextPs = await prisma.pluginSkill.findFirst({
        where:   { plugin: { slug: pluginSlug }, order: { gt: skillOrder }, skill: { isActive: true } },
        orderBy: { order: 'asc' },
        include: { skill: true },
      });
      if (nextPs) {
        console.log(`[Deal] Chaining to next skill "${nextPs.skill.slug}" (order=${nextPs.order})`);
        await enqueueSkillJob(pluginSlug, nextPs, {
          ...job.data,
          skillOrder:      nextPs.order,
          type:            nextPs.skill.slug,
          skillName:       nextPs.skill.slug,
          rootJobBullmqId: job.id,
        });
        chained = true;
      }
    }

    // Only mark completed if nothing is chained after this job
    if (!chained) {
      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { callId, scenariosGenerated: Object.keys(dealResult) } },
      });
    }

    await job.updateProgress(100);
    console.log(`[Deal] Job ${job.id} completed${chained ? ' — waiting for chain' : ''}`);
    return { result: dealResult, prompt };

  } catch (error) {
    console.error(`[Deal] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: 'deal_analysis', status: 'failed', bullmqId: job.id, error: error.message }
      });
    } catch (dbErr) {
      console.error(`[Deal] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('deal_analysis', processDealJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 }
});

worker.on('completed', job      => console.log(`[deal] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[deal] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[deal] Worker error:', err));

console.log('Deal analysis worker ready');

module.exports = worker;
