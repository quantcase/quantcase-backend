'use strict';

const { Worker }   = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson }               = require('../utils/workerUtils');
const { nseIndustryPrompt, selectCompanies,
        loadCompanyData }                    = require('../prompts/of-prompts/nse-industry-prompt');
const { loadSkillConfig }                    = require('../utils/skillConfig');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processNseIndustryJob(job) {
  const { subjectTicker, type } = job.data;
  console.log(`[NseIndustry] Job ${job.id} (subjectTicker: ${subjectTicker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId: subjectTicker, type: type || 'nse_industry', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(10);

    // ── 1. Resolve industry for subject ticker ────────────────────────────
    const call = await prisma.earnings_calls.findFirst({
      where:  { company: subjectTicker },
      select: { basic_industry: true, bfsi: true },
    });
    if (!call) throw new Error(`No earnings call found for ticker ${subjectTicker}`);
    const industry = call.basic_industry;
    const bfsi     = !!call.bfsi;
    if (!industry) throw new Error(`No basic_industry mapped for ticker ${subjectTicker}`);
    console.log(`[NseIndustry] industry: ${industry}, bfsi: ${bfsi}`);
    await job.updateProgress(20);

    // ── 2. Select top 5 companies by market cap (subject first) ──────────
    const companies = await selectCompanies(prisma, subjectTicker, industry, 5);
    console.log(`[NseIndustry] companies selected: ${companies.map(c => c.ticker).join(', ')}`);
    await job.updateProgress(30);

    // ── 3. Load prowess + kpi + summaries for all companies ───────────────
    const companyData = await loadCompanyData(prisma, companies);
    console.log(`[NseIndustry] company data loaded for ${companyData.length} companies`);
    await job.updateProgress(50);

    // ── 4. Load skill config + build prompt ───────────────────────────────
    const { model, maxTokens, promptTemplate, defaultInstructions } = await loadSkillConfig('nse-industry');
    const prompt = nseIndustryPrompt(industry, companyData, bfsi, promptTemplate, defaultInstructions);
    console.log(`[NseIndustry] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(55);

    // ── 5. LLM call ───────────────────────────────────────────────────────
    console.log('[NseIndustry] Calling LLM...');
    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const result = parseJson(responseText);
    await job.updateProgress(90);

    // ── 6. Upsert into ai_insights ────────────────────────────────────────
    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
      update: { insight: result },
      create: { ticker: subjectTicker, type: 'nse_industry', insight: result },
    });
    console.log(`[NseIndustry] ai_insights upserted for ticker: ${subjectTicker}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { subjectTicker, industry } },
    });

    await job.updateProgress(100);
    console.log(`[NseIndustry] Job ${job.id} completed`);
    return { subjectTicker, industry, result };

  } catch (error) {
    console.error(`[NseIndustry] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: subjectTicker, type: type || 'nse_industry', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error('[NseIndustry] Failed to update job in DB:', dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('nse_industry', processNseIndustryJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[nse-industry] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[nse-industry] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[nse-industry] Worker error:', err));

console.log('NSE Industry worker ready');

module.exports = worker;
