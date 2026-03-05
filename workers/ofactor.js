'use strict';

const { Worker } = require('bullmq');
const { connection, prisma, llmStream, parseJson } = require('../lib/workerSetup');
const { upsertOFactorSection }      = require('../db-utils/upsertOFactor');
const { FinHelper }                 = require('../utils/finHelper');
const { industryPrompt }            = require('../prompts/of-prompts/industry-prompt');
const { competitionPrompt }         = require('../prompts/of-prompts/competition-prompt');
const { financialStrengthPrompt }   = require('../prompts/of-prompts/financial-strength-prompt');
const { customerTractionPrompt }    = require('../prompts/of-prompts/customer-traction-prompt');

const MAX_TOKENS = 16000;

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getSubjectSummaries(companyPrefix) {
  const rows = await prisma.summaryNew.findMany({
    where:   { callId: { startsWith: companyPrefix } },
    orderBy: { callId: 'desc' }, // callId format TICKER_FYYYY_QX sorts correctly by fiscal period
    take:    2
  });
  return rows.reverse(); // oldest → newest
}

/**
 * Auto-discover up to 2 peer companies in the same industry from summaryNew.
 */
async function getAutoPeerSummaries(subjectTicker, industry) {
  if (!industry || industry === 'Unknown Industry') return [];

  const allPeerSummaries = await prisma.summaryNew.findMany({
    where: {
      industryAnalysis: { path: ['industry'], equals: industry },
      NOT: { callId: { startsWith: subjectTicker } }
    },
    orderBy: { createdAt: 'desc' }
  });

  // Keep the latest summary per peer ticker
  const seen = new Map();
  for (const s of allPeerSummaries) {
    const ticker = s.callId.split('_FY')[0];
    if (!seen.has(ticker)) {
      seen.set(ticker, s);
      if (seen.size >= 2) break;
    }
  }

  const peerTickers = [...seen.keys()];
  console.log(`[OFactor] Auto-discovered peer tickers for "${industry}": ${peerTickers.join(', ') || 'none'}`);
  return [...seen.values()];
}

// ─── Section-Specific Prompt Builders ────────────────────────────────────────

async function buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, helper) {
  const [industryOpm, industryRevCagr, industryEps, industryPe] = await Promise.all([
    industry !== 'Unknown Industry' ? helper.industryOpm(industry)      : Promise.resolve(null),
    industry !== 'Unknown Industry' ? helper.industryRevCagr(industry)  : Promise.resolve(null),
    industry !== 'Unknown Industry' ? helper.industryEpsCagr(industry)  : Promise.resolve(null),
    industry !== 'Unknown Industry' ? helper.industryPeCagr(industry)   : Promise.resolve(null),
  ]);

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const peerData    = peerSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const metrics     = { industryOpm, industryRevCagr, industryEps, industryPe };

  return { prompt: industryPrompt(subjectTicker, industry, subjectData, peerData, metrics), sectionKey: 'industry_overview' };
}

async function buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, helper) {
  const [stockEps, stockPe, industryEps, industryPe] = await Promise.all([
    helper.stockEpsCagr(subjectTicker),
    helper.stockPeCagr(subjectTicker),
    industry !== 'Unknown Industry' ? helper.industryEpsCagr(industry) : Promise.resolve(null),
    industry !== 'Unknown Industry' ? helper.industryPeCagr(industry)  : Promise.resolve(null),
  ]);

  const pickFields = s => ({
    callId: s.callId, entities: s.entities, milestones: s.milestones, kpis: s.kpis,
    governanceSignals: s.governanceSignals, riskDisclosures: s.riskDisclosures, tone: s.tone
  });

  const subjectData = subjectSummaries.map(pickFields);
  const peerData    = peerSummaries.map(pickFields);
  const metrics     = { stockEps, stockPe, industryEps, industryPe };

  return { prompt: competitionPrompt(subjectTicker, industry, subjectData, peerData, metrics), sectionKey: 'competition' };
}

async function buildFinancialStrengthSection(subjectTicker, subjectSummaries, helper) {
  const [stockEps, stockPe, stockRevCagr, roce, fcf, deRatio, netDebtEbitda, ic, cr, opm] = await Promise.all([
    helper.stockEpsCagr(subjectTicker),
    helper.stockPeCagr(subjectTicker),
    helper.stockRevCagr(subjectTicker),
    helper.stockRoceLatest(subjectTicker),
    helper.stockFcfLatest(subjectTicker),
    helper.computeDeRatio(subjectTicker),
    helper.computeNetDebtEbitda(subjectTicker),
    helper.computeIc(subjectTicker),
    helper.computeCr(subjectTicker),
    helper.stockKpiLatest(subjectTicker, 'OPM'),
  ]);

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, financialStrength: s.financialStrength }));
  const metrics     = { stockEps, stockPe, stockRevCagr, roce, fcf, deRatio, netDebtEbitda, ic, cr, opm };

  return { prompt: financialStrengthPrompt(subjectTicker, subjectData, metrics), sectionKey: 'financial_strength' };
}

async function buildCustomerTractionSection(subjectTicker, subjectSummaries, helper) {
  const [custLatest, custCagr] = await Promise.all([
    helper.stockKpiLatest(subjectTicker, 'CUST'),
    helper.stockCustCagr(subjectTicker),
  ]);

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, clientTraction: s.clientTraction }));
  const metrics     = { custLatest, custCagr };

  return { prompt: customerTractionPrompt(subjectTicker, subjectData, metrics), sectionKey: 'customer_traction' };
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, section, type } = job.data;
  console.log(`Processing OFactor job ${job.id} (callId: ${callId}, subject: ${subjectTicker}, section: ${section})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'ofactor_analysis', status: 'processing', bullmqId: job.id }
    });
    await job.updateProgress(5);

    if (!VALID_SECTIONS.has(section)) {
      throw new Error(`Invalid section: "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`);
    }

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const fallbackIndustry = call.basic_industry || 'Unknown Industry';
    await job.updateProgress(10);

    // Fetch subject summaries → resolve industry
    const subjectSummaries = await getSubjectSummaries(subjectTicker);
    const latestSummary    = subjectSummaries[subjectSummaries.length - 1];
    const industry = latestSummary?.industryAnalysis?.industry || fallbackIndustry;
    console.log(`[OFactor] Resolved industry: "${industry}"`);
    await job.updateProgress(20);

    // Peer discovery (needed for industry + competition sections)
    const needsPeers = section === 'industry' || section === 'competition';
    const peerSummaries = needsPeers ? await getAutoPeerSummaries(subjectTicker, industry) : [];
    console.log(`Subject summaries: ${subjectSummaries.length}, Peer summaries: ${peerSummaries.length}`);
    await job.updateProgress(30);

    // Build section-specific prompt + pre-computed metrics
    const helper = new FinHelper(prisma);
    let promptText, sectionKey;

    if (section === 'industry') {
      ({ prompt: promptText, sectionKey } = await buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, helper));
    } else if (section === 'competition') {
      ({ prompt: promptText, sectionKey } = await buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, helper));
    } else if (section === 'financial_strength') {
      ({ prompt: promptText, sectionKey } = await buildFinancialStrengthSection(subjectTicker, subjectSummaries, helper));
    } else {
      ({ prompt: promptText, sectionKey } = await buildCustomerTractionSection(subjectTicker, subjectSummaries, helper));
    }

    console.log(`[OFactor] Section "${section}" prompt length: ${promptText.length} chars`);
    await job.updateProgress(55);

    console.log(`[OFactor] Calling LLM for section "${section}"...`);
    const responseText = await llmStream({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: promptText }]
    });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    console.log(`[OFactor] Parsing section "${section}" response...`);
    const parsed = parseJson(responseText);

    // The LLM returns { <sectionKey>: <sectionData> } — extract the section data
    const sectionResult = parsed[sectionKey] ?? parsed;
    await job.updateProgress(90);

    await upsertOFactorSection(callId, subjectTicker, section, sectionResult, prisma);
    console.log(`[OFactor] Section "${section}" saved for callId: ${callId}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId, section, sectionKey } }
    });

    await job.updateProgress(100);
    console.log(`[OFactor] Job ${job.id} completed (section: ${section})`);
    return { section, sectionKey };

  } catch (error) {
    console.error(`[OFactor] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: type || 'ofactor_analysis', status: 'failed', bullmqId: job.id, error: error.message }
      });
    } catch (dbErr) {
      console.error(`[OFactor] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('ofactor_analysis', processOFactorJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 }
});

worker.on('completed', job       => console.log(`[ofactor] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[ofactor] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[ofactor] Worker error:', err));

console.log('OFactor analysis worker ready');

module.exports = worker;
