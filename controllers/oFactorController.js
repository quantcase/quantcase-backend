'use strict';

const prisma = require('../lib/prisma');
const { getOFactorResult, getLatestOFactorResultByTicker } = require('../db-utils/upsertOFactor');
const { isBFSI } = require('../utils/industryClassifier');

// ── Helper: fetch Q4-based stats for one ticker ───────────────────────────────
// Revenue = full-year Q4 REV_OP; Revenue Growth = YoY vs previous Q4.
// OPM, ROCE, D/E are derived from raw stored KPIs rather than pre-computed abbrs.
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

  // Use LLM-reported units (value / multiplier) to match display expectations
  const kpiMap = new Map(kpiRows.map(k => [k.kpi_abbr, k.value / (k.multiplier || 1)]));
  const get = (abbr) => {
    const val = kpiMap.get(abbr);
    return val != null && !isNaN(val) ? val : null;
  };

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

  // OPM (EBITDA margin) = (PBT + FIN_COST + DEP_AMORT - OTH_INC) / REV_OP × 100
  let opm = null;
  if (pbt != null && revOp) {
    opm = parseFloat(((pbt + finCost + depAmort - othInc) / revOp * 100).toFixed(2));
  }

  // ROCE = (PBT + FIN_COST) / (TOTAL_ASSETS - CURR_LIAB) × 100
  let roce = null;
  if (pbt != null && totalAssets != null && currLiab != null) {
    const ce = totalAssets - currLiab;
    if (ce > 0) roce = parseFloat(((pbt + finCost) / ce * 100).toFixed(2));
  }

  // D/E = (DEBT_LT + DEBT_ST) / (EQ_SHARE_CAP + RES_SURPLUS)
  let debtEquity = null;
  if (eqShareCap != null && resSurplus != null) {
    const equity = eqShareCap + resSurplus;
    if (equity > 0) debtEquity = parseFloat(((debtLt + debtSt) / equity).toFixed(2));
  }

  // Revenue Growth = YoY vs previous Q4
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

/**
 * Remove cards from the OFactor result that don't apply to BFSI or non-BFSI companies.
 * BFSI: remove working_capital, free_cash_flow, operating_leverage from financial_strength
 *       and opm_trend from industry_overview.text
 * Non-BFSI: remove industry_aum from industry_overview.metrics
 */
function filterOFactorForIndustry(result, bfsi) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };

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

async function getOFactorAnalysis(req, res) {
  try {
    const { callId } = req.params;

    const [record, call] = await Promise.all([
      getOFactorResult(callId),
      prisma.earnings_calls.findUnique({ where: { id: callId }, select: { basic_industry: true } }),
    ]);

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    const filteredResult = filterOFactorForIndustry(record.result, isBFSI(call?.basic_industry));
    const totalScore = computeTotalScore(filteredResult);
    res.json({ success: true, data: filteredResult, total_score: totalScore });
  } catch (error) {
    console.error('Error fetching OFactor analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch OFactor analysis', message: error.message });
  }
}

async function getOFactorAnalysisByQuery(req, res) {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }
  try {
    let record = await getOFactorResult(callId);
    let industry = null;

    if (!record) {
      const call = await prisma.earnings_calls.findUnique({ where: { id: callId }, select: { company: true, basic_industry: true } });
      industry = call?.basic_industry ?? null;
      const ticker = call?.company ?? callId.replace(/_FY\d+_Q\d+$/i, '');
      record = await getLatestOFactorResultByTicker(ticker);
    } else {
      const call = await prisma.earnings_calls.findFirst({
        where:   { company: record.subjectTicker },
        select:  { basic_industry: true },
        orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
      });
      industry = call?.basic_industry ?? null;
    }

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    const filteredResult = filterOFactorForIndustry(record.result, isBFSI(industry));
    const totalScore = computeTotalScore(filteredResult);
    res.json({ success: true, data: filteredResult, total_score: totalScore });
  } catch (error) {
    console.error('Error fetching OFactor analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch OFactor analysis', message: error.message });
  }
}

const DENOMINATION_UNIT = { percentage: '%', rupee: 'Cr', ratio: 'x', other: '' };

function fmtInrCr(val) {
  if (val == null || isNaN(val)) return null;
  const sign = val < 0 ? '-' : '';
  const abs  = Math.abs(val);
  // Values may be in absolute rupees (value / multiplier where multiplier=1);
  // convert to Crores if >= 1 Crore (1e7 rupees)
  const inCrores = abs >= 1e7 ? abs / 1e7 : abs;
  return `${sign}${inCrores.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
}

function formatKpiValue(val, denomination, callDate) {
  const unit = DENOMINATION_UNIT[denomination] ?? '';
  let display = val;
  // For rupee KPIs, value may be in absolute rupees; normalize to Crores if >= 1 Crore
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

// ── Helper: industry_specific KPI timeseries for multiple tickers (batched) ──
async function getPeerIndustryKpiTimeseries(peerTickers) {
  if (!peerTickers.length) return [];

  const [allCalls, industryKpis] = await Promise.all([
    prisma.earnings_calls.findMany({
      where:   { company: { in: peerTickers } },
      select:  { id: true, company: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    }),
    prisma.kpi.findMany({
      where:  { kpi_type: 'industry_specific' },
      select: { abbr: true, denomination: true },
    }),
  ]);

  if (!industryKpis.length) return peerTickers.map(t => ({ ticker: t, timeseries: [] }));
  const industrySet = new Set(industryKpis.map(k => k.abbr));
  const unitMap = Object.fromEntries(industryKpis.map(k => [k.abbr, k.denomination]));

  // Keep only last 10 calls per ticker
  const countPerTicker = {};
  const filteredCalls = [];
  for (const c of allCalls) {
    countPerTicker[c.company] = (countPerTicker[c.company] ?? 0);
    if (countPerTicker[c.company] < 10) {
      filteredCalls.push(c);
      countPerTicker[c.company]++;
    }
  }

  const callIds  = filteredCalls.map(c => c.id);
  const callMeta = Object.fromEntries(filteredCalls.map(c => [c.id, c]));

  // Fetch all non-QE kpi_values for industry-specific abbrs
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
      .map(([abbr, data]) => ({
        kpi_abbr:         abbr,
        quarters_present: data.length,
        data:             data.sort((a, b) => (a.period < b.period ? -1 : 1)),
      }))
      .sort((a, b) => b.quarters_present - a.quarters_present),
  }));
}

// ── Helper: industry_specific KPI timeseries for last 10 calls ────────────────
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
    // All non-QE kpi_values for industry-specific abbrs
    prisma.kpiValue.findMany({
      where:  { callId: { in: callIds }, source: { not: 'QE' } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
    }),
    prisma.kpi.findMany({
      where:  { kpi_type: 'industry_specific' },
      select: { abbr: true, denomination: true },
    }),
  ]);

  if (!industryKpis.length) return [];

  const industrySet = new Set(industryKpis.map(k => k.abbr));
  const unitMap = Object.fromEntries(industryKpis.map(k => [k.abbr, k.denomination]));

  const kpiData = {};   // abbr → [{ period, value }]
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

  // Sort data chronologically (oldest first), rank KPIs by quarters_present desc
  return Object.entries(kpiData)
    .map(([abbr, data]) => ({
      kpi_abbr:         abbr,
      quarters_present: data.length,
      data:             data.sort((a, b) => (a.period < b.period ? -1 : 1)),
    }))
    .sort((a, b) => b.quarters_present - a.quarters_present);
}

async function getPeerData(req, res) {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }

  try {
    const call = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { company: true, company_name: true, basic_industry: true },
    });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
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
        take:    5,
      });
      peerTickers = peerGroups.map(r => r.company);
    }

    const allTickers = [subjectTicker, ...peerTickers];

    const [nameRows, statsResults, industryTimeseries, rawPeerKpiTimeseries] = await Promise.all([
      prisma.earnings_calls.findMany({
        where:    { company: { in: allTickers } },
        select:   { company: true, company_name: true },
        distinct: ['company'],
      }),
      Promise.allSettled(allTickers.map(getQ4Stats)),
      getIndustryKpiTimeseries(subjectTicker),
      getPeerIndustryKpiTimeseries(peerTickers),
    ]);

    const nameMap = Object.fromEntries(nameRows.map(r => [r.company, r.company_name]));

    // Only show KPIs that subject AND at least one peer both have data for
    const peerKpiAbbrSet = new Set();
    rawPeerKpiTimeseries.forEach(p => p.timeseries.forEach(k => peerKpiAbbrSet.add(k.kpi_abbr)));
    const sharedAbbrs = new Set(
      industryTimeseries.filter(k => peerKpiAbbrSet.has(k.kpi_abbr)).map(k => k.kpi_abbr),
    );

    const peerKpiTimeseries = [
      // Subject company first
      {
        ticker:       subjectTicker,
        company_name: nameMap[subjectTicker] ?? subjectTicker,
        timeseries:   industryTimeseries.filter(k => sharedAbbrs.has(k.kpi_abbr)),
      },
      // Peers — filtered to shared KPIs only
      ...rawPeerKpiTimeseries.map(p => ({
        ticker:       p.ticker,
        company_name: nameMap[p.ticker] ?? p.ticker,
        timeseries:   p.timeseries.filter(k => sharedAbbrs.has(k.kpi_abbr)),
      })),
    ];

    const rows = statsResults.map((r, i) => ({
      ticker: allTickers[i],
      ...(r.status === 'fulfilled' && r.value
        ? r.value
        : { revenue: null, revenueGrowth: null, opm: null, roce: null, debtEquity: null }),
    }));

    const totalRevenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0);

    // Compute raw market shares, then adjust last non-null entry so they sum to exactly 100
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

    // Revenue-weighted average (market-share weighted) for all metrics
    const weightedAvg = (field) => {
      const valid = peers.filter(p => p[field] != null && p.revenue != null);
      if (!valid.length) return null;
      const totalW = valid.reduce((s, p) => s + p.revenue, 0);
      if (totalW === 0) return null;
      return parseFloat((valid.reduce((s, p) => s + p[field] * p.revenue, 0) / totalW).toFixed(2));
    };
    peers.push({
      company:        'Industry Average',
      revenue:        weightedAvg('revenue'),
      revenue_growth: weightedAvg('revenue_growth'),
      opm:            weightedAvg('opm'),
      roce:           weightedAvg('roce'),
      market_share:   null,
      debt_equity:    weightedAvg('debt_equity'),
      is_current:     false,
      is_average:     true,
    });

    const formattedPeers = peers.map(p => ({
      ...p,
      revenue: fmtInrCr(p.revenue),
    }));

    res.json({
      success: true,
      competition: {
        meta: { section_id: 'competition', title: 'Competitive Benchmarking' },
        peers: formattedPeers,
      },
      industry_kpis: {
        meta:       { section_id: 'industry_kpis', title: 'Industry KPI Trends' },
        timeseries: industryTimeseries,
      },
      peer_kpi_timeseries: {
        meta:      { section_id: 'peer_kpi_timeseries', title: 'Peer Industry KPI Trends' },
        companies: peerKpiTimeseries,
      },
    });
  } catch (error) {
    console.error('Error fetching peer data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch peer data', message: error.message });
  }
}

module.exports = { getOFactorAnalysis, getOFactorAnalysisByQuery, getPeerData };
