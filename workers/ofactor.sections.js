'use strict';

const prisma = require('../config/prisma');
const { isBFSI }                                    = require('../utils/industryClassifier');
const { industryPrompt }                            = require('../prompts/of-prompts/industry-prompt');
const { competitionPrompt }                         = require('../prompts/of-prompts/competition-prompt');
const { financialStrengthPrompt }                   = require('../prompts/of-prompts/financial-strength-prompt');
const { financialStrengthInsightsPrompt }           = require('../prompts/of-prompts/financial-strength-insights-prompt');
const { customerTractionPrompt }                    = require('../prompts/of-prompts/customer-traction-prompt');
const { finalTakeawaysPrompt }                      = require('../prompts/of-prompts/final-takeaways-prompt');
const { computeFinancialStrengthExtras, deepMerge } = require('../utils/finExtras');
const {
  fetchTimeSeriesBatch, fetchDerivedBatch,
  fetchStockCagr, fetchStockPeCagr,
  fetchIndustryCagr, fetchIndustryPeCagr,
  fetchEarningsLatest, fetchEarningsCagr,
} = require('../utils/formulaRegistry');

async function buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, prismaArg, customInstructions, dbTemplate, dbInstructions) {
  const RAW_ABBRS = [
    'REV_OP', 'TOTAL_INCOME', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
    'EMP_EXP', 'OTH_EXP', 'FIN_COST', 'DEP_AMORT',
    'PBT', 'PAT', 'TOTAL_ASSETS', 'CURR_LIAB',
  ];

  const bfsi = isBFSI(industry);
  const [rawBatch, derivedBatch] = await Promise.all([
    fetchTimeSeriesBatch(prismaArg, subjectTicker, RAW_ABBRS),
    fetchDerivedBatch(prismaArg, subjectTicker, bfsi),
  ]);

  const q4Only = batch => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
  );

  const subjectData = subjectSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const peerData    = peerSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
  const metrics     = { rawBatch: q4Only(rawBatch), derivedBatch: q4Only(derivedBatch), derivedBatchAll: derivedBatch, bfsi };

  return { prompt: industryPrompt(subjectTicker, industry, subjectData, peerData, metrics, customInstructions, dbTemplate, dbInstructions), sectionKey: 'industry_overview' };
}

async function buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, prismaArg, customInstructions, dbTemplate, dbInstructions) {
  const allCallIds = [...subjectSummaries, ...peerSummaries].map(s => s.callId);

  const [stockEps, stockPe, industryEps, industryPe, kpiRows] = await Promise.all([
    fetchStockCagr(prismaArg, subjectTicker, 'EPS_BASIC'),
    fetchStockPeCagr(prismaArg, subjectTicker),
    industry !== 'Unknown Industry' ? fetchIndustryCagr(prismaArg, industry, 'EPS_BASIC') : Promise.resolve(null),
    industry !== 'Unknown Industry' ? fetchIndustryPeCagr(prismaArg, industry) : Promise.resolve(null),
    prisma.kpiValue.findMany({
      where:  { callId: { in: allCallIds } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

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

async function buildFinancialStrengthSection(subjectTicker, industry, subjectSummaries, prismaArg, customInstructions, dbTemplate, dbInstructions) {
  const RAW_ABBRS = [
    'REV_OP', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
    'EMP_EXP', 'OTH_EXP', 'DEP_AMORT', 'FIN_COST',
    'PAT', 'PBT', 'CFO',
    'TRADE_RECV', 'TRADE_PAY', 'INVENTORY',
    'DEBT_LT', 'DEBT_ST', 'CASH_EQUIV',
    'EQ_SHARE_CAP', 'RES_SURPLUS',
    'ASSET_PPE', 'ASSET_CWIP',
    'TOTAL_ASSETS', 'CURR_LIAB', 'PROV_CONT',
    'DIV_PAYOUT',
  ];

  const bfsi = isBFSI(industry);
  console.log(`[OFactor] financial_strength — industry="${industry}", bfsi=${bfsi}`);

  const [rawBatch, derivedBatch, mcRows] = await Promise.all([
    fetchTimeSeriesBatch(prismaArg, subjectTicker, RAW_ABBRS),
    fetchDerivedBatch(prismaArg, subjectTicker, bfsi),
    prisma.$queryRaw`SELECT mc."market_cap(Cr)"::text AS market_cap FROM market_cap mc WHERE mc.symbol = ${subjectTicker} ORDER BY mc.date DESC NULLS LAST LIMIT 1`,
  ]);

  const marketCap = mcRows[0]?.market_cap != null ? parseFloat(mcRows[0].market_cap) : null;
  console.log(`[OFactor] financial_strength marketCap for ${subjectTicker}: ${marketCap}`);

  const q4Only = batch => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
  );
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

async function buildFinancialStrengthInsightsSection(subjectTicker, industry, prismaArg, dbTemplate) {
  const RAW_ABBRS = [
    'REV_OP', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
    'EMP_EXP', 'OTH_EXP', 'DEP_AMORT', 'FIN_COST',
    'PAT', 'PBT', 'CFO',
    'TRADE_RECV', 'TRADE_PAY', 'INVENTORY',
    'DEBT_LT', 'DEBT_ST', 'CASH_EQUIV',
    'EQ_SHARE_CAP', 'RES_SURPLUS',
    'ASSET_PPE', 'ASSET_CWIP',
    'TOTAL_ASSETS', 'CURR_LIAB', 'PROV_CONT',
    'DIV_PAYOUT',
  ];

  const bfsi = isBFSI(industry);
  const [rawBatch, derivedBatch, mcRows] = await Promise.all([
    fetchTimeSeriesBatch(prismaArg, subjectTicker, RAW_ABBRS),
    fetchDerivedBatch(prismaArg, subjectTicker, bfsi),
    prisma.$queryRaw`SELECT mc."market_cap(Cr)"::text AS market_cap FROM market_cap mc WHERE mc.symbol = ${subjectTicker} ORDER BY mc.date DESC NULLS LAST LIMIT 1`,
  ]);

  const marketCap = mcRows[0]?.market_cap != null ? parseFloat(mcRows[0].market_cap) : null;

  const lastNQuarters = (batch, n = 10) => Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.slice(-n)])
  );

  const rawBatchAll     = lastNQuarters(rawBatch);
  const derivedBatchAll = lastNQuarters(derivedBatch);
  const localExtras     = computeFinancialStrengthExtras(rawBatchAll, derivedBatchAll, bfsi, marketCap);

  return {
    prompt:     financialStrengthInsightsPrompt(subjectTicker, localExtras, bfsi, dbTemplate),
    sectionKey: 'financial_strength_insights',
    localExtras,
    bfsi,
  };
}

async function buildCustomerTractionSection(subjectTicker, subjectSummaries, prismaArg, customInstructions, dbTemplate, dbInstructions) {
  const subjectCallIds = subjectSummaries.map(s => s.callId);

  const [custLatest, custCagr, relevantKpiRows, kpiRows] = await Promise.all([
    fetchEarningsLatest(prismaArg, subjectTicker, 'CUST'),
    fetchEarningsCagr(prismaArg, subjectTicker, 'CUST'),
    prisma.kpi.findMany({ where: { kpi_type: { in: ['industry_specific', 'customer_kpis'] } }, select: { abbr: true } }),
    prisma.kpiValue.findMany({
      where:  { callId: { in: subjectCallIds } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

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

module.exports = {
  buildIndustrySection,
  buildCompetitionSection,
  buildFinancialStrengthSection,
  buildFinancialStrengthInsightsSection,
  buildCustomerTractionSection,
  buildFinalTakeawaysSection,
};
