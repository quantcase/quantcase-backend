'use strict';

const { Worker } = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { upsertOFactorSection }      = require('../services/db/ofactor.db');
const { enqueueSkillJob }           = require('../services/plugins.service');
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
  competition:        'ofactor-competition',
  financial_strength: 'ofactor-financial-strength',
  customer_traction:  'ofactor-customer-traction',
  final_takeaways:    'ofactor-final-takeaways',
};

function resolveIndustrySkill(bfsi) {
  return bfsi ? 'ofactor-industry-bfsi' : 'ofactor-industry';
}


// ─── Plugin chaining ─────────────────────────────────────────────────────────

/**
 * Update the `all_steps` array on the root job's DB record.
 * Marks `currentSlug` with `currentStatus`, and optionally marks the next step as 'processing'.
 */
async function updateAllSteps(rootJobBullmqId, currentSlug, currentStatus, nextSlug) {
  if (!rootJobBullmqId) return;
  try {
    const rootJob = await prisma.job.findUnique({ where: { bullmqId: rootJobBullmqId } });
    if (!rootJob?.result?.all_steps) return;

    const all_steps = rootJob.result.all_steps.map(step => {
      if (step.analysis_type === currentSlug) return { ...step, status: currentStatus };
      if (nextSlug && step.analysis_type === nextSlug) return { ...step, status: 'processing' };
      return step;
    });

    await prisma.job.update({
      where: { bullmqId: rootJobBullmqId },
      data:  { result: { ...rootJob.result, all_steps } },
    });
  } catch (err) {
    console.error('[Chain] Failed to update all_steps:', err.message);
  }
}

/**
 * After a skill completes successfully, look up the next active skill in the
 * same plugin chain (by order) and enqueue it.  No-ops when:
 *   - the job wasn't started from a plugin chain (no pluginSlug / skillOrder)
 *   - this was the last skill in the chain
 */
async function enqueueNextPluginSkill(jobData, selfJobId) {
  const { pluginSlug, skillOrder, callId, subjectTicker, type: currentSlug, all_steps } = jobData;
  // rootJobBullmqId may be null for the first job in the chain (the root job is its own root).
  // In that case, fall back to selfJobId (the BullMQ job's own ID).
  const rootJobBullmqId = jobData.rootJobBullmqId ?? selfJobId ?? null;
  if (!pluginSlug || skillOrder == null) return;

  const nextPs = await prisma.pluginSkill.findFirst({
    where: {
      plugin: { slug: pluginSlug },
      order:  { gt: skillOrder },
      skill:  { isActive: true },
    },
    orderBy: { order: 'asc' },
    include: { skill: true },
  });

  if (!nextPs) {
    // Last skill in the chain — mark current as completed
    await updateAllSteps(rootJobBullmqId, currentSlug, 'completed', null);
    return;
  }

  const nextSlug = nextPs.skill.slug;
  console.log(`[Chain] ${pluginSlug}: queuing next skill "${nextSlug}" (order=${nextPs.order})`);

  // Mark current step completed, next step as processing
  await updateAllSteps(rootJobBullmqId, currentSlug, 'completed', nextSlug);

  await enqueueSkillJob(pluginSlug, nextPs, { callId, subjectTicker, rootJobBullmqId, all_steps });
}

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
  // Read existing record first so we can preserve result (which holds all_steps written by addFullOpportunityAnalysis)
  const existingNseJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
  const preserveResult = existingNseJob?.result ? { result: existingNseJob.result } : {};
  await prisma.job.upsert({
    where:  { bullmqId: job.id },
    update: { status: 'processing', ...preserveResult },
    create: { callId: subjectTicker, type: 'nse_industry', status: 'processing', bullmqId: job.id },
  });
  await job.updateProgress(10);

  // Cache check — skip the heavy LLM call if nse_industry already exists for this ticker
  const existingInsight = await prisma.aiInsight.findUnique({
    where: { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
  });
  if (existingInsight) {
    console.log(`[NseIndustry] Cache hit — skipping LLM for ${subjectTicker}, nse_industry already exists`);
    const cachedCall = await prisma.earnings_calls.findFirst({
      where:  { company: subjectTicker },
      select: { basic_industry: true },
    });
    const cachedIndustry = cachedCall?.basic_industry ?? 'Unknown Industry';
    // enqueueNextPluginSkill marks current step 'completed' and next step 'processing' in all_steps — must run first
    await enqueueNextPluginSkill(job.data, job.id);
    // Re-fetch after enqueueNextPluginSkill so we merge on top of the updated all_steps, not the stale copy
    const cachedRootJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { ...(cachedRootJob?.result ?? {}), subjectTicker, industry: cachedIndustry, cached: true } },
    });
    await job.updateProgress(100);
    return { subjectTicker, industry: cachedIndustry, cached: true };
  }

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

  const { model, maxTokens, promptTemplate } = await loadSkillConfig('nse-industry');
  const prompt = nseIndustryPrompt(industry, companyData, bfsi, promptTemplate);
  console.log(`[NseIndustry] Prompt length: ${prompt.length} chars`);
  await job.updateProgress(55);

  console.log('[NseIndustry] Calling LLM...');
  const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  await job.updateProgress(85);

  if (!responseText) throw new Error('Empty response from LLM');
  const result = parseJson(responseText);
  await job.updateProgress(90);

  await prisma.aiInsight.upsert({
    where:  { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
    update: { insight: result },
    create: { ticker: subjectTicker, type: 'nse_industry', insight: result },
  });
  console.log(`[NseIndustry] ai_insights upserted for: ${subjectTicker}`);

  // enqueueNextPluginSkill updates all_steps (marks current completed, next processing),
  // so call it first so the all_steps update is already in DB before we merge below.
  await enqueueNextPluginSkill(job.data, job.id);

  // Merge completion fields into the existing result so all_steps (updated above) is preserved.
  const nseRootJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
  await prisma.job.update({
    where: { bullmqId: job.id },
    data:  { status: 'completed', result: { ...(nseRootJob?.result ?? {}), subjectTicker, industry } },
  });
  await job.updateProgress(100);
  return { subjectTicker, industry, result };

  } catch (error) {
    console.error(`[NseIndustry] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: subjectTicker, type: 'nse_industry', status: 'failed', bullmqId: job.id, error: error.message },
      });
      await updateAllSteps(job.data.rootJobBullmqId, job.data.type, 'failed', null);
    } catch (dbErr) { console.error('[NseIndustry] Failed to update job in DB:', dbErr); }
    throw error;
  }
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, section, type, customInstructions, customRun } = job.data;

  // Dispatch NSE industry jobs to their own processor
  if (type === 'nse-industry' || type === 'industry') return processNseIndustryJob(job);

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
    const bfsiFlag         = isBFSI(call.basic_industry);
    await job.updateProgress(10);

    const skillSlug = section === 'industry' ? resolveIndustrySkill(bfsiFlag) : SECTION_TO_SKILL[section];
    const { model, maxTokens, outputSchema, promptTemplate: dbTemplate, defaultInstructions: dbInstructions } = await loadSkillConfig(skillSlug);

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
      messages: [{ role: 'user', content: promptText }],
      ...(outputSchema && { response_format: outputSchema }),
    });
    await job.updateProgress(85);

    console.log(`[OFactor] LLM response length: ${responseText?.length ?? 0} chars`);
    if (!responseText || !responseText.trim()) throw new Error('Empty response from LLM');

    console.log(`[OFactor] Parsing section "${section}" response...`);
    const parsed = parseJson(responseText);

    // The LLM returns { <sectionKey>: <sectionData> } — extract the section data.
    // Some DB prompt templates instruct the LLM to return a flat object without the wrapper key;
    // in that case we use the full parsed object directly.
    let sectionResult;
    if (sectionKey in parsed) {
      sectionResult = parsed[sectionKey];
    } else {
      sectionResult = parsed;
      console.log(`[OFactor] Section "${section}": LLM returned flat object (keys: [${Object.keys(parsed).join(', ')}]) — using directly as section result.`);
    }

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

    await enqueueNextPluginSkill(job.data, job.id);
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
      await updateAllSteps(job.data.rootJobBullmqId, job.data.type, 'failed', null);
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
