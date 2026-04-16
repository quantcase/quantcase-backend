'use strict';

const { Worker } = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { upsertOFactorSection }      = require('../services/db/ofactor.db');
const { FinHelper }                 = require('../utils/finHelper');
const { isBFSI }                    = require('../utils/industryClassifier');
const { industryPrompt }            = require('../prompts/of-prompts/industry-prompt');
const { competitionPrompt }         = require('../prompts/of-prompts/competition-prompt');
const { financialStrengthPrompt }   = require('../prompts/of-prompts/financial-strength-prompt');
const { customerTractionPrompt }    = require('../prompts/of-prompts/customer-traction-prompt');
const { finalTakeawaysPrompt }      = require('../prompts/of-prompts/final-takeaways-prompt');
const { loadSkillConfig }           = require('../utils/skillConfig');
const { nseIndustryPrompt, selectCompanies, loadCompanyData } = require('../prompts/of-prompts/nse-industry-prompt');

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction', 'final_takeaways']);

const SECTION_TO_SKILL = {
  industry:           'ofactor-industry',
  competition:        'ofactor-competition',
  financial_strength: 'ofactor-financial-strength',
  customer_traction:  'ofactor-customer-traction',
  final_takeaways:    'ofactor-final-takeaways',
};


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
 * Auto-discover up to 2 peer companies in the same industry via earnings_calls.basic_industry.
 */
async function getAutoPeerSummaries(subjectTicker, industry) {
  if (!industry || industry === 'Unknown Industry') return [];

  // Build latest callId per peer ticker (all peers, no limit yet)
  const peerCalls = await prisma.earnings_calls.findMany({
    where:   { basic_industry: industry, NOT: { company: subjectTicker } },
    select:  { company: true, id: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  const latestCallByTicker = new Map();
  for (const c of peerCalls) {
    if (!latestCallByTicker.has(c.company)) latestCallByTicker.set(c.company, c.id);
  }

  if (latestCallByTicker.size === 0) return [];

  // Only pick peers whose latest call has a summaryNew record
  const allLatestCallIds = [...latestCallByTicker.values()];
  const available = await prisma.summaryNew.findMany({
    where:  { callId: { in: allLatestCallIds } },
    select: { callId: true },
  });

  const availableCallIds = new Set(available.map(s => s.callId));
  const pickedCallIds = allLatestCallIds.filter(id => availableCallIds.has(id)).slice(0, 2);

  if (pickedCallIds.length === 0) return [];

  const peerTickers = pickedCallIds.map(id => id.split('_FY')[0]);
  console.log(`[OFactor] Auto-discovered peer tickers for "${industry}": ${peerTickers.join(', ')}`);

  const summaries = await prisma.summaryNew.findMany({
    where: { callId: { in: pickedCallIds } },
  });

  return summaries;
}

// ─── Section-Specific Prompt Builders ────────────────────────────────────────

async function buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, helper, customInstructions, dbTemplate, dbInstructions) {
  const RAW_ABBRS = [
    'REV_OP', 'TOTAL_INCOME', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
    'EMP_EXP', 'OTH_EXP', 'FIN_COST', 'DEP_AMORT',
    'PBT', 'PAT', 'TOTAL_ASSETS', 'CURR_LIAB',
  ];

  const bfsi = isBFSI(industry);
  const [rawBatch, derivedBatch] = await Promise.all([
    helper.getTimeSeriesBatch(subjectTicker, RAW_ABBRS),
    helper.getDerivedKpiBatch(subjectTicker, bfsi),
  ]);

  const q4Only = batch => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
  );

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const peerData    = peerSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const metrics     = { rawBatch: q4Only(rawBatch), derivedBatch: q4Only(derivedBatch), derivedBatchAll: derivedBatch, bfsi };

  return { prompt: industryPrompt(subjectTicker, industry, subjectData, peerData, metrics, customInstructions, dbTemplate, dbInstructions), sectionKey: 'industry_overview' };
}

async function buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, helper, customInstructions, dbTemplate, dbInstructions) {
  const allCallIds = [...subjectSummaries, ...peerSummaries].map(s => s.callId);

  const [stockEps, stockPe, industryEps, industryPe, kpiRows] = await Promise.all([
    helper.stockEpsCagr(subjectTicker),
    helper.stockPeCagr(subjectTicker),
    industry !== 'Unknown Industry' ? helper.industryEpsCagr(industry) : Promise.resolve(null),
    industry !== 'Unknown Industry' ? helper.industryPeCagr(industry)  : Promise.resolve(null),
    prisma.kpiValue.findMany({
      where:  { callId: { in: allCallIds } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  // Group kpi_values by callId as { kpi_abbr, value } for the competition prompt
  const kpiByCall = {};
  for (const row of kpiRows) {
    if (!kpiByCall[row.callId]) kpiByCall[row.callId] = [];
    kpiByCall[row.callId].push({ kpi_abbr: row.kpi_abbr, value: row.value / (row.multiplier || 1) });
  }

  const pickFields = s => ({
    callId:            s.callId,
    entities:          s.entities,
    milestones:        s.milestones,
    kpis:              kpiByCall[s.callId] ?? [],
    governanceSignals: s.governanceSignals,
    riskDisclosures:   s.riskDisclosures,
    tone:              s.tone,
  });

  const subjectData = subjectSummaries.map(pickFields);
  const peerData    = peerSummaries.map(pickFields);
  const metrics     = { stockEps, stockPe, industryEps, industryPe };

  return { prompt: competitionPrompt(subjectTicker, industry, subjectData, peerData, metrics, customInstructions, dbTemplate, dbInstructions), sectionKey: 'competition' };
}

async function buildFinancialStrengthSection(subjectTicker, industry, subjectSummaries, helper, customInstructions, dbTemplate, dbInstructions) {
  const RAW_ABBRS = [
    'REV_OP', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
    'EMP_EXP', 'OTH_EXP', 'DEP_AMORT', 'FIN_COST',
    'PAT', 'PBT', 'CFO',
    'TRADE_RECV', 'TRADE_PAY', 'INVENTORY',
    'DEBT_LT', 'DEBT_ST', 'CASH_EQUIV',
    'EQ_SHARE_CAP', 'RES_SURPLUS',
    'ASSET_PPE', 'ASSET_CWIP',
    'TOTAL_ASSETS', 'CURR_LIAB', 'PROV_CONT',
    // Dividend payout (for equity allocation)
    'DIV_PAYOUT',
  ];

  const bfsi = isBFSI(industry);
  console.log(`[OFactor] financial_strength — industry="${industry}", bfsi=${bfsi}`);

  const [rawBatch, derivedBatch, mcRows] = await Promise.all([
    helper.getTimeSeriesBatch(subjectTicker, RAW_ABBRS),
    helper.getDerivedKpiBatch(subjectTicker, bfsi),
    prisma.$queryRaw`SELECT mc."market_cap(Cr)"::text AS market_cap FROM market_cap mc WHERE mc.symbol = ${subjectTicker} ORDER BY mc.date DESC NULLS LAST LIMIT 1`,
  ]);

  const marketCap = mcRows[0]?.market_cap != null ? parseFloat(mcRows[0].market_cap) : null;
  console.log(`[OFactor] financial_strength marketCap for ${subjectTicker}: ${marketCap}`);

  const q4Only = batch => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
  );

  // Last 10 quarters for chart arrays (DOL chart, WC table, FCF conversion etc.)
  const lastNQuarters = (batch, n = 10) => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.slice(-n)])
  );

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, financialStrength: s.financialStrength }));
  const metrics = {
    rawBatch:        q4Only(rawBatch),
    derivedBatch:    q4Only(derivedBatch),
    rawBatchAll:     lastNQuarters(rawBatch),
    derivedBatchAll: lastNQuarters(derivedBatch),
    bfsi,
    marketCap,
  };

  return { prompt: financialStrengthPrompt(subjectTicker, subjectData, metrics, customInstructions, dbTemplate, dbInstructions), sectionKey: 'financial_strength' };
}

async function buildCustomerTractionSection(subjectTicker, subjectSummaries, helper, customInstructions, dbTemplate, dbInstructions) {
  const subjectCallIds = subjectSummaries.map(s => s.callId);

  const [custLatest, custCagr, relevantKpiRows, kpiRows] = await Promise.all([
    helper.stockKpiLatest(subjectTicker, 'CUST'),
    helper.stockCustCagr(subjectTicker),
    prisma.kpi.findMany({ where: { kpi_type: { in: ['industry_specific', 'customer_kpis'] } }, select: { abbr: true } }),
    prisma.kpiValue.findMany({
      where:  { callId: { in: subjectCallIds } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  // Fallback: if CUST KPI not found in kpiValue, scan transcript summary kpis
  let resolvedCustLatest = custLatest;
  if (custLatest.value == null) {
    for (const s of [...subjectSummaries].reverse()) {
      const kpis = s.clientTraction?.customer_growth?.kpis ?? [];
      const match = kpis.find(k => k.kpi_abbr === 'CUST' && k.value != null);
      if (match) {
        resolvedCustLatest = { value: match.value, abbrUsed: 'CUST', period: s.callId, type: 'transcript' };
        console.log(`[OFactor] CUST fallback from transcript ${s.callId}: ${match.value}`);
        break;
      }
    }
  }

  // Filter: total revenue + all industry_specific + customer_kpis KPIs
  const relevantSet = new Set(relevantKpiRows.map(k => k.abbr));
  const kpiByCall   = {};
  for (const row of kpiRows) {
    if (row.kpi_abbr === 'REV_OP' || relevantSet.has(row.kpi_abbr)) {
      if (!kpiByCall[row.callId]) kpiByCall[row.callId] = [];
      kpiByCall[row.callId].push({ kpi_abbr: row.kpi_abbr, value: row.value / (row.multiplier || 1) });
    }
  }

  const subjectData = subjectSummaries.map(s => ({
    callId:         s.callId,
    kpis:           kpiByCall[s.callId] ?? [],
    clientTraction: s.clientTraction,
  }));
  const metrics = { custLatest: resolvedCustLatest, custCagr };

  return { prompt: customerTractionPrompt(subjectTicker, subjectData, metrics, customInstructions, dbTemplate, dbInstructions), sectionKey: 'customer_traction' };
}

async function buildFinalTakeawaysSection(callId, dbTemplate) {
  const record = await prisma.oFactorResult.findUnique({ where: { callId } });
  if (!record?.result) throw new Error(`No oFactorResult found for callId: ${callId}`);

  const { industry_overview, competition, financial_strength, customer_traction } = record.result;
  const missing = ['industry_overview', 'competition', 'financial_strength', 'customer_traction']
    .filter(k => !record.result[k]);
  if (missing.length) throw new Error(`Cannot build final_takeaways — missing sections: ${missing.join(', ')}`);

  const prompt = finalTakeawaysPrompt(
    record.subjectTicker,
    industry_overview?.meta?.subtitle ?? 'Unknown Industry',
    { industry_overview, competition, financial_strength, customer_traction },
    dbTemplate,
  );

  return { prompt, sectionKey: 'final_takeaways' };
}

// ─── NSE Industry processor ───────────────────────────────────────────────────

async function processNseIndustryJob(job) {
  const { subjectTicker, type } = job.data;
  console.log(`[NseIndustry] Job ${job.id} (subjectTicker: ${subjectTicker})`);

  try {
  await prisma.job.upsert({
    where:  { bullmqId: job.id },
    update: { status: 'processing' },
    create: { callId: subjectTicker, type: type || 'industry', status: 'processing', bullmqId: job.id },
  });
  await job.updateProgress(10);

  const call = await prisma.earnings_calls.findFirst({
    where:  { company: subjectTicker },
    select: { basic_industry: true },
  });
  if (!call) throw new Error(`No earnings call found for ticker ${subjectTicker}`);
  const industry = call.basic_industry;
  const bfsi     = false;
  if (!industry) throw new Error(`No basic_industry mapped for ticker ${subjectTicker}`);
  console.log(`[NseIndustry] industry: ${industry}, bfsi: ${bfsi}`);
  await job.updateProgress(20);

  const companies = await selectCompanies(prisma, subjectTicker, industry, 5);
  console.log(`[NseIndustry] companies: ${companies.map(c => c.ticker).join(', ')}`);
  await job.updateProgress(30);

  const companyData = await loadCompanyData(prisma, companies);
  await job.updateProgress(50);

  const { model, maxTokens, promptTemplate, defaultInstructions } = await loadSkillConfig('nse-industry');
  const prompt = nseIndustryPrompt(industry, companyData, bfsi, promptTemplate, defaultInstructions);
  console.log(`[NseIndustry] Prompt length: ${prompt.length} chars`);
  await job.updateProgress(55);

  console.log('[NseIndustry] Calling LLM...');
  const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  await job.updateProgress(85);

  if (!responseText) throw new Error('Empty response from LLM');
  const result = parseJson(responseText);
  await job.updateProgress(90);

  await prisma.aiInsight.upsert({
    where:  { ticker_type: { ticker: subjectTicker, type: 'industry' } },
    update: { insight: result },
    create: { ticker: subjectTicker, type: 'industry', insight: result },
  });
  console.log(`[NseIndustry] ai_insights upserted for: ${subjectTicker}`);

  await prisma.job.update({
    where: { bullmqId: job.id },
    data:  { status: 'completed', result: { subjectTicker, industry } },
  });
  await job.updateProgress(100);
  return { subjectTicker, industry, result };

  } catch (error) {
    console.error(`[NseIndustry] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: subjectTicker, type: type || 'industry', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) { console.error('[NseIndustry] Failed to update job in DB:', dbErr); }
    throw error;
  }
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, section, type, customInstructions, customRun } = job.data;

  // Dispatch industry jobs to their own processor
  if (type === 'industry') return processNseIndustryJob(job);

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

    const { model, maxTokens, promptTemplate: dbTemplate, defaultInstructions: dbInstructions } = await loadSkillConfig(SECTION_TO_SKILL[section]);

    let promptText, sectionKey;

    if (section === 'final_takeaways') {
      // Reads directly from saved oFactorResult — no summaries/peers/helper needed
      ({ prompt: promptText, sectionKey } = await buildFinalTakeawaysSection(callId, dbTemplate));
      await job.updateProgress(55);
    } else {
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

    if (section === 'industry') {
      ({ prompt: promptText, sectionKey } = await buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, helper, customInstructions, dbTemplate, dbInstructions));
    } else if (section === 'competition') {
      ({ prompt: promptText, sectionKey } = await buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, helper, customInstructions, dbTemplate, dbInstructions));
    } else if (section === 'financial_strength') {
      ({ prompt: promptText, sectionKey } = await buildFinancialStrengthSection(subjectTicker, industry, subjectSummaries, helper, customInstructions, dbTemplate, dbInstructions));
    } else {
      ({ prompt: promptText, sectionKey } = await buildCustomerTractionSection(subjectTicker, subjectSummaries, helper, customInstructions, dbTemplate, dbInstructions));
    }
    } // end else (non-final_takeaways sections)

    console.log(`[OFactor] Section "${section}" prompt length: ${promptText.length} chars`);
    await job.updateProgress(55);

    console.log(`[OFactor] Calling LLM for section "${section}"...`);
    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: promptText }]
    });
    await job.updateProgress(85);

    console.log(`[OFactor] LLM response length: ${responseText?.length ?? 0} chars`);
    if (!responseText || !responseText.trim()) throw new Error('Empty response from LLM');

    console.log(`[OFactor] Parsing section "${section}" response...`);
    const parsed = parseJson(responseText);

    // The LLM returns { <sectionKey>: <sectionData> } — extract the section data
    if (!(sectionKey in parsed)) {
      const topKeys = Object.keys(parsed);
      console.warn(`[OFactor] WARNING: expected key "${sectionKey}" not found in LLM response. Top-level keys: [${topKeys.join(', ')}]. Falling back to full parsed object.`);
    }
    const sectionResult = parsed[sectionKey] ?? parsed;

    if (!sectionResult || (typeof sectionResult === 'object' && Object.keys(sectionResult).length === 0)) {
      throw new Error(`[OFactor] Section "${section}" result is empty after parsing. Raw response (first 500 chars): ${responseText.slice(0, 500)}`);
    }
    await job.updateProgress(90);

    if (customRun) {
      // Custom runs: do NOT overwrite oFactorResult — result lives in BullMQ returnvalue only
      console.log(`[OFactor] Custom run — section "${section}" returning in returnvalue (callId: ${callId})`);
      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { callId, section, sectionKey } }
      });
    } else {
      await upsertOFactorSection(callId, subjectTicker, section, sectionResult, prisma);
      console.log(`[OFactor] Section "${section}" saved for callId: ${callId}`);
      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { callId, section, sectionKey, sectionResult } }
      });
    }

    await job.updateProgress(100);
    console.log(`[OFactor] Job ${job.id} completed (section: ${section})`);
    // sectionResult is in returnvalue so frontend can read it via GET /api/jobs/:jobId
    return { section, sectionKey, sectionResult, prompt: promptText };

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
