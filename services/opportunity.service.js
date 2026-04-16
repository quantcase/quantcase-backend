'use strict';

const prisma = require('../config/prisma');
const { getOFactorResult, getLatestOFactorResultByTicker } = require('./db/ofactor.db');
const { isBFSI } = require('../utils/industryClassifier');

const { METRICS: INDUSTRY_METRICS }                  = require('../prompts/of-prompts/industry-prompt');
const { METRICS: COMPETITION_METRICS }               = require('../prompts/of-prompts/competition-prompt');
const { METRICS: FINANCIAL_STRENGTH_METRICS }        = require('../prompts/of-prompts/financial-strength-prompt');
const { METRICS: CUSTOMER_TRACTION_METRICS }         = require('../prompts/of-prompts/customer-traction-prompt');

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

const SECTION_META = {
  industry:           { metrics: INDUSTRY_METRICS },
  competition:        { metrics: COMPETITION_METRICS },
  financial_strength: { metrics: FINANCIAL_STRENGTH_METRICS },
  customer_traction:  { metrics: CUSTOMER_TRACTION_METRICS },
};

/**
 * Resolve whether a callId belongs to a BFSI company.
 */
async function resolveBfsi(callId) {
  if (!callId) return false;
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { basic_industry: true },
  });
  return isBFSI(call?.basic_industry);
}

/**
 * Normalize the financial_strength section from the new schema shape
 * { core, final_scoring, extras } → flat shape { text, metrics, operating_leverage, ... }
 * that the rest of the codebase expects. No-ops if already in flat shape.
 */
function normalizeFinancialStrength(fs) {
  if (!fs || typeof fs !== 'object') return fs;
  // Already flat (old shape) — has text/metrics at top level
  if (fs.text || fs.metrics) return fs;
  // New shape — flatten core + extras + final_scoring
  const { core = {}, extras = {}, final_scoring, ...rest } = fs;
  return {
    ...rest,
    ...(core.text    ? { text: core.text }       : {}),
    ...(core.metrics ? { metrics: core.metrics }  : {}),
    ...(extras.operating_leverage ? { operating_leverage: extras.operating_leverage } : {}),
    ...(extras.free_cash_flow     ? { free_cash_flow:     extras.free_cash_flow }     : {}),
    ...(extras.working_capital    ? { working_capital:    extras.working_capital }    : {}),
    ...(extras.capital_structure  ? { capital_structure:  extras.capital_structure }  : {}),
    ...(final_scoring             ? { final_scoring }                                 : {}),
  };
}

/**
 * Remove cards from the OFactor result that don't apply to BFSI or non-BFSI companies.
 */
function filterOFactorForIndustry(result, bfsi) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };

  if (out.financial_strength) {
    out.financial_strength = normalizeFinancialStrength(out.financial_strength);
  }

  if (bfsi) {
    if (out.financial_strength) {
      const fs = { ...out.financial_strength };
      delete fs.working_capital;
      delete fs.free_cash_flow;
      delete fs.operating_leverage;
      if (fs.text) {
        const text = { ...fs.text };
        delete text.opm_trend;
        fs.text = text;
      }
      out.financial_strength = fs;
    }
    if (out.industry_overview?.text) {
      const io = { ...out.industry_overview };
      io.text = { ...io.text };
      delete io.text.opm_trend;
      out.industry_overview = io;
    }
  } else {
    if (out.industry_overview?.metrics) {
      const io = { ...out.industry_overview };
      io.metrics = { ...io.metrics };
      delete io.metrics.industry_aum;
      out.industry_overview = io;
    }
  }

  return out;
}

function computeTotalScore(result) {
  if (!result) return null;
  const SECTIONS = [
    { key: 'industry_overview',  path: result.industry_overview?.final_scoring,  max: 10 },
    { key: 'competition',        path: result.competition?.final_scoring,        max: 10 },
    { key: 'financial_strength', path: result.financial_strength?.final_scoring, max: 10 },
    { key: 'customer_traction',  path: result.customer_traction?.final_scoring,  max: 10 },
  ];
  const present = SECTIONS.filter(s => s.path?.score != null);
  if (!present.length) return null;
  return {
    total_score: present.reduce((sum, s) => sum + Number(s.path.score), 0),
    max_score:   present.reduce((sum, s) => sum + s.max, 0),
    sections:    present.map(s => ({ section: s.key, score: Number(s.path.score), max_score: s.max })),
  };
}

async function getOFactorForCall(callId) {
  const [record, call] = await Promise.all([
    getOFactorResult(callId),
    prisma.earnings_calls.findUnique({ where: { id: callId }, select: { basic_industry: true } }),
  ]);
  if (!record) return null;
  const filteredResult = filterOFactorForIndustry(record.result, isBFSI(call?.basic_industry));
  return { result: filteredResult, total_score: computeTotalScore(filteredResult) };
}

async function getOFactorByQuery(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, basic_industry: true },
  });
  const ticker   = call?.company ?? callId.replace(/_FY\d+_Q\d+$/i, '');
  const industry = call?.basic_industry ?? null;

  // Fetch industry from ai_insights + remaining sections from oFactorResult in parallel
  let ofactorRecord = await getOFactorResult(callId);
  if (!ofactorRecord) ofactorRecord = await getLatestOFactorResultByTicker(ticker);

  const industryInsight = await prisma.aiInsight.findUnique({
    where: { ticker_type: { ticker, type: 'nse_industry' } },
  });

  if (!ofactorRecord && !industryInsight) return null;

  const base   = ofactorRecord ? filterOFactorForIndustry(ofactorRecord.result, isBFSI(industry)) : {};
  // NSE industry insight is stored as { industry_analysis: { ... } } — expose it at the top level
  const nseIndustry = industryInsight?.insight?.industry_analysis ?? industryInsight?.insight ?? null;
  const result = {
    ...base,
    ...(nseIndustry ? { industry_analysis: nseIndustry } : {}),
  };

  return { result, total_score: computeTotalScore(result) };
}

function getOFactorPromptData(section, bfsi) {
  if (!VALID_SECTIONS.has(section)) {
    const err = new Error(`Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`);
    err.status = 400;
    throw err;
  }
  const meta = SECTION_META[section];
  return { section, bfsi, metrics: meta.metrics };
}

// ─── Peer data helpers ────────────────────────────────────────────────────────

const DENOMINATION_UNIT = { percentage: '%', rupee: 'Cr', ratio: 'x', other: '' };

function fmtInrCr(val) {
  if (val == null || isNaN(val)) return null;
  const sign = val < 0 ? '-' : '';
  const abs  = Math.abs(val);
  const inCrores = abs >= 1e7 ? abs / 1e7 : abs;
  return `${sign}${inCrores.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
}

function formatKpiValue(val, denomination, callDate) {
  const unit = DENOMINATION_UNIT[denomination] ?? '';
  let display = val;
  if (denomination === 'rupee' && typeof val === 'number' && Math.abs(val) >= 1e7) {
    display = val / 1e7;
  }
  const numStr = typeof display === 'number'
    ? display.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : String(display);
  let str = numStr;
  if (unit) str += ` ${unit}`;
  if (callDate) str += ` (${callDate})`;
  return str;
}

async function getQ4Stats(ticker) {
  const q4Calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker, quarter: 'Q4' },
    select:  { id: true, fiscal_year: true },
    orderBy: { fiscal_year: 'desc' },
  });
  if (!q4Calls.length) return null;

  const latestQ4 = q4Calls[0];
  const prevQ4   = q4Calls[1] ?? null;

  const kpiRows = await prisma.kpiValue.findMany({
    where:  { callId: latestQ4.id },
    select: { kpi_abbr: true, value: true, multiplier: true },
  });
  if (!kpiRows.length) return null;

  const kpiMap = new Map(kpiRows.map(k => [k.kpi_abbr, k.value / (k.multiplier || 1)]));
  const get = (abbr) => { const val = kpiMap.get(abbr); return val != null && !isNaN(val) ? val : null; };

  const revOp      = get('REV_OP');
  const pbt        = get('PBT');
  const finCost    = get('FIN_COST')    ?? 0;
  const depAmort   = get('DEP_AMORT')   ?? 0;
  const othInc     = get('OTH_INC')     ?? 0;
  const totalAssets= get('TOTAL_ASSETS');
  const currLiab   = get('CURR_LIAB');
  const eqShareCap = get('EQ_SHARE_CAP');
  const resSurplus = get('RES_SURPLUS');
  const debtLt     = get('DEBT_LT')     ?? 0;
  const debtSt     = get('DEBT_ST')     ?? 0;

  let opm = null;
  if (pbt != null && revOp) {
    opm = parseFloat(((pbt + finCost + depAmort - othInc) / revOp * 100).toFixed(2));
  }

  let roce = null;
  if (pbt != null && totalAssets != null && currLiab != null) {
    const ce = totalAssets - currLiab;
    if (ce > 0) roce = parseFloat(((pbt + finCost) / ce * 100).toFixed(2));
  }

  let debtEquity = null;
  if (eqShareCap != null && resSurplus != null) {
    const equity = eqShareCap + resSurplus;
    if (equity > 0) debtEquity = parseFloat(((debtLt + debtSt) / equity).toFixed(2));
  }

  let revenueGrowth = null;
  if (prevQ4 && revOp != null) {
    const prevRow = await prisma.kpiValue.findFirst({
      where:  { callId: prevQ4.id, kpi_abbr: 'REV_OP' },
      select: { value: true, multiplier: true },
    });
    if (prevRow?.value != null) {
      const prevRev = prevRow.value / (prevRow.multiplier || 1);
      if (!isNaN(prevRev) && prevRev > 0) {
        revenueGrowth = parseFloat(((revOp - prevRev) / prevRev * 100).toFixed(2));
      }
    }
  }

  return { revenue: revOp, revenueGrowth, opm, roce, debtEquity };
}

async function getPeerIndustryKpiTimeseries(peerTickers) {
  if (!peerTickers.length) return [];

  const [allCalls, industryKpis] = await Promise.all([
    prisma.earnings_calls.findMany({
      where:   { company: { in: peerTickers } },
      select:  { id: true, company: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    }),
    prisma.kpi.findMany({ where: { kpi_type: 'industry_specific' }, select: { abbr: true, denomination: true } }),
  ]);

  if (!industryKpis.length) return peerTickers.map(t => ({ ticker: t, timeseries: [] }));
  const industrySet = new Set(industryKpis.map(k => k.abbr));
  const unitMap = Object.fromEntries(industryKpis.map(k => [k.abbr, k.denomination]));

  const countPerTicker = {};
  const filteredCalls = [];
  for (const c of allCalls) {
    countPerTicker[c.company] = (countPerTicker[c.company] ?? 0);
    if (countPerTicker[c.company] < 10) { filteredCalls.push(c); countPerTicker[c.company]++; }
  }

  const callIds  = filteredCalls.map(c => c.id);
  const callMeta = Object.fromEntries(filteredCalls.map(c => [c.id, c]));

  const kpiRows = await prisma.kpiValue.findMany({
    where:  { callId: { in: callIds }, kpi_abbr: { in: [...industrySet] }, source: { not: 'QE' } },
    select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
  });

  const kpiDataByTicker = Object.fromEntries(peerTickers.map(t => [t, {}]));
  for (const row of kpiRows) {
    const meta = callMeta[row.callId];
    if (!meta) continue;
    const kpiData = kpiDataByTicker[meta.company];
    if (!kpiData) continue;
    const val = row.value / (row.multiplier || 1);
    if (isNaN(val)) continue;
    const period = `${meta.fiscal_year}-${meta.quarter}`;
    if (!kpiData[row.kpi_abbr]) kpiData[row.kpi_abbr] = [];
    kpiData[row.kpi_abbr].push({ period, value: formatKpiValue(val, unitMap[row.kpi_abbr], meta.call_date) });
  }

  return peerTickers.map(ticker => ({
    ticker,
    timeseries: Object.entries(kpiDataByTicker[ticker] ?? {})
      .map(([abbr, data]) => ({ kpi_abbr: abbr, quarters_present: data.length, data: data.sort((a, b) => (a.period < b.period ? -1 : 1)) }))
      .sort((a, b) => b.quarters_present - a.quarters_present),
  }));
}

async function getIndustryKpiTimeseries(ticker) {
  const calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker },
    select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    take:    10,
  });
  if (!calls.length) return [];

  const callIds  = calls.map(c => c.id);
  const callMeta = Object.fromEntries(calls.map(c => [c.id, c]));

  const [kpiRows, industryKpis] = await Promise.all([
    prisma.kpiValue.findMany({
      where:  { callId: { in: callIds }, source: { not: 'QE' } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
    prisma.kpi.findMany({ where: { kpi_type: 'industry_specific' }, select: { abbr: true, denomination: true } }),
  ]);

  if (!industryKpis.length) return [];
  const industrySet = new Set(industryKpis.map(k => k.abbr));
  const unitMap = Object.fromEntries(industryKpis.map(k => [k.abbr, k.denomination]));

  const kpiData = {};
  for (const row of kpiRows) {
    if (!industrySet.has(row.kpi_abbr)) continue;
    const meta = callMeta[row.callId];
    if (!meta) continue;
    const val = row.value / (row.multiplier || 1);
    if (isNaN(val)) continue;
    const period = `${meta.fiscal_year}-${meta.quarter}`;
    if (!kpiData[row.kpi_abbr]) kpiData[row.kpi_abbr] = [];
    kpiData[row.kpi_abbr].push({ period, value: formatKpiValue(val, unitMap[row.kpi_abbr], meta.call_date) });
  }

  return Object.entries(kpiData)
    .map(([abbr, data]) => ({ kpi_abbr: abbr, quarters_present: data.length, data: data.sort((a, b) => (a.period < b.period ? -1 : 1)) }))
    .sort((a, b) => b.quarters_present - a.quarters_present);
}

async function getPeerDataForCall(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, company_name: true, basic_industry: true },
  });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  const subjectTicker = call.company;
  const industry = call.basic_industry;

  let peerTickers = [];
  if (industry) {
    const peerGroups = await prisma.earnings_calls.groupBy({
      by:      ['company'],
      where:   { basic_industry: industry, company: { not: subjectTicker }, quarter: 'Q4' },
      _count:  { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    const candidateTickers = peerGroups.map(r => r.company);

    if (candidateTickers.length > 0) {
      const latestCalls = await prisma.earnings_calls.findMany({
        where:    { company: { in: candidateTickers } },
        select:   { id: true, company: true },
        orderBy:  [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
        distinct: ['company'],
      });
      const latestCallIdByTicker = Object.fromEntries(latestCalls.map(c => [c.company, c.id]));

      const latestCallIds = latestCalls.map(c => c.id);
      const summaryNewRecords = await prisma.summaryNew.findMany({
        where:  { callId: { in: latestCallIds } },
        select: { callId: true },
      });
      const summaryNewCallIds = new Set(summaryNewRecords.map(s => s.callId));

      const withSummary    = candidateTickers.filter(t => summaryNewCallIds.has(latestCallIdByTicker[t]));
      const withoutSummary = candidateTickers.filter(t => !summaryNewCallIds.has(latestCallIdByTicker[t]));
      peerTickers = [...withSummary, ...withoutSummary].slice(0, 5);
    }
  }

  const allTickers = [subjectTicker, ...peerTickers];

  const [nameRows, statsResults, industryTimeseries, rawPeerKpiTimeseries] = await Promise.all([
    prisma.earnings_calls.findMany({ where: { company: { in: allTickers } }, select: { company: true, company_name: true }, distinct: ['company'] }),
    Promise.allSettled(allTickers.map(getQ4Stats)),
    getIndustryKpiTimeseries(subjectTicker),
    getPeerIndustryKpiTimeseries(peerTickers),
  ]);

  const nameMap = Object.fromEntries(nameRows.map(r => [r.company, r.company_name]));

  const peerKpiAbbrSet = new Set();
  rawPeerKpiTimeseries.forEach(p => p.timeseries.forEach(k => peerKpiAbbrSet.add(k.kpi_abbr)));
  const sharedAbbrs = new Set(
    industryTimeseries.filter(k => peerKpiAbbrSet.has(k.kpi_abbr)).map(k => k.kpi_abbr),
  );

  const peerKpiTimeseries = [
    { ticker: subjectTicker, company_name: nameMap[subjectTicker] ?? subjectTicker, timeseries: industryTimeseries.filter(k => sharedAbbrs.has(k.kpi_abbr)) },
    ...rawPeerKpiTimeseries.map(p => ({ ticker: p.ticker, company_name: nameMap[p.ticker] ?? p.ticker, timeseries: p.timeseries.filter(k => sharedAbbrs.has(k.kpi_abbr)) })),
  ];

  const rows = statsResults.map((r, i) => ({
    ticker: allTickers[i],
    ...(r.status === 'fulfilled' && r.value
      ? r.value
      : { revenue: null, revenueGrowth: null, opm: null, roce: null, debtEquity: null }),
  }));

  const totalRevenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0);
  const rawShares = rows.map(r =>
    totalRevenue > 0 && r.revenue != null ? (r.revenue / totalRevenue) * 100 : null,
  );
  const nonNullIdx = rawShares.reduce((acc, v, i) => (v !== null ? [...acc, i] : acc), []);
  const marketShares = rawShares.map(() => null);
  if (nonNullIdx.length > 0) {
    let sum = 0;
    for (let i = 0; i < nonNullIdx.length - 1; i++) {
      const idx = nonNullIdx[i];
      const rounded = parseFloat(rawShares[idx].toFixed(2));
      marketShares[idx] = rounded;
      sum += rounded;
    }
    const lastIdx = nonNullIdx[nonNullIdx.length - 1];
    marketShares[lastIdx] = parseFloat((100 - sum).toFixed(2));
  }

  const peers = rows.map((r, i) => ({
    company:        nameMap[r.ticker] ?? r.ticker,
    revenue:        r.revenue,
    revenue_growth: r.revenueGrowth,
    opm:            r.opm,
    roce:           r.roce,
    market_share:   marketShares[i],
    debt_equity:    r.debtEquity,
    is_current:     r.ticker === subjectTicker,
    is_average:     false,
  }));

  const weightedAvg = (field) => {
    const valid = peers.filter(p => p[field] != null && p.revenue != null);
    if (!valid.length) return null;
    const totalW = valid.reduce((s, p) => s + p.revenue, 0);
    if (totalW === 0) return null;
    return parseFloat((valid.reduce((s, p) => s + p[field] * p.revenue, 0) / totalW).toFixed(2));
  };
  peers.push({ company: 'Industry Average', revenue: weightedAvg('revenue'), revenue_growth: weightedAvg('revenue_growth'), opm: weightedAvg('opm'), roce: weightedAvg('roce'), market_share: null, debt_equity: weightedAvg('debt_equity'), is_current: false, is_average: true });

  const formattedPeers = peers.map(p => ({ ...p, revenue: fmtInrCr(p.revenue) }));

  return {
    competition: { meta: { section_id: 'competition', title: 'Competitive Benchmarking' }, peers: formattedPeers },
    industry_kpis: { meta: { section_id: 'industry_kpis', title: 'Industry KPI Trends' }, timeseries: industryTimeseries },
    peer_kpi_timeseries: { meta: { section_id: 'peer_kpi_timeseries', title: 'Peer Industry KPI Trends' }, companies: peerKpiTimeseries },
  };
}

module.exports = {
  resolveBfsi,
  filterOFactorForIndustry,
  computeTotalScore,
  getOFactorForCall,
  getOFactorByQuery,
  getOFactorPromptData,
  getPeerDataForCall,
  VALID_SECTIONS,
};
