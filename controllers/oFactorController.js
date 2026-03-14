'use strict';

const prisma = require('../lib/prisma');
const { getOFactorResult, getLatestOFactorResultByTicker } = require('../db-utils/upsertOFactor');

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

  const summary = await prisma.summaryNew.findUnique({
    where:  { callId: latestQ4.id },
    select: { kpis: true },
  });
  if (!summary?.kpis || !Array.isArray(summary.kpis)) return null;

  const kpis = summary.kpis;
  const get = (abbr) => {
    const match = kpis.find(k => k.kpi_abbr === abbr);
    if (!match) return null;
    const val = parseFloat(match.kpi_value ?? match.value);
    return isNaN(val) ? null : val;
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
    const prevSummary = await prisma.summaryNew.findUnique({
      where:  { callId: prevQ4.id },
      select: { kpis: true },
    });
    if (prevSummary?.kpis && Array.isArray(prevSummary.kpis)) {
      const prevMatch = prevSummary.kpis.find(k => k.kpi_abbr === 'REV_OP');
      if (prevMatch) {
        const prevRev = parseFloat(prevMatch.kpi_value ?? prevMatch.value);
        if (!isNaN(prevRev) && prevRev > 0) {
          revenueGrowth = parseFloat(((revOp - prevRev) / prevRev * 100).toFixed(2));
        }
      }
    }
  }

  return { revenue: revOp, revenueGrowth, opm, roce, debtEquity };
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

    const record = await getOFactorResult(callId);

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    const totalScore = computeTotalScore(record.result);
    res.json({ success: true, data: record.result, total_score: totalScore });
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

    if (!record) {
      const call = await prisma.earnings_calls.findUnique({ where: { id: callId }, select: { company: true } });
      const ticker = call?.company ?? callId.replace(/_FY\d+_Q\d+$/i, '');
      record = await getLatestOFactorResultByTicker(ticker);
    }

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    const totalScore = computeTotalScore(record.result);
    res.json({ success: true, data: record.result, total_score: totalScore });
  } catch (error) {
    console.error('Error fetching OFactor analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch OFactor analysis', message: error.message });
  }
}

const DENOMINATION_UNIT = { percentage: '%', rupee: 'Cr', ratio: 'x', other: '' };

function formatKpiValue(val, denomination, callDate) {
  const unit = DENOMINATION_UNIT[denomination] ?? '';
  let str = String(val);
  if (unit) str += ` ${unit}`;
  if (callDate) str += ` (${callDate})`;
  return str;
}

// ── Helper: industry_specific KPI timeseries for multiple tickers (batched) ──
async function getPeerIndustryKpiTimeseries(peerTickers) {
  if (!peerTickers.length) return [];

  const [allCalls, industryKpis] = await Promise.all([
    prisma.earnings_calls.findMany({
      where:   { company: { in: peerTickers }, quarter: 'Q4' },
      select:  { id: true, company: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'desc' }],
    }),
    prisma.kpi.findMany({
      where:  { kpi_type: 'industry_specific' },
      select: { abbr: true, denomination: true },
    }),
  ]);

  if (!industryKpis.length) return peerTickers.map(t => ({ ticker: t, timeseries: [] }));
  const industrySet = new Set(industryKpis.map(k => k.abbr));
  const unitMap = Object.fromEntries(industryKpis.map(k => [k.abbr, k.denomination]));

  // Keep only last 5 Q4 calls per ticker (allCalls already ordered desc by fiscal_year)
  const countPerTicker = {};
  const filteredCalls = [];
  for (const c of allCalls) {
    countPerTicker[c.company] = (countPerTicker[c.company] ?? 0);
    if (countPerTicker[c.company] < 5) {
      filteredCalls.push(c);
      countPerTicker[c.company]++;
    }
  }

  const callIds  = filteredCalls.map(c => c.id);
  const callMeta = Object.fromEntries(filteredCalls.map(c => [c.id, c]));

  const summaries = await prisma.summaryNew.findMany({
    where:  { callId: { in: callIds } },
    select: { callId: true, milestones: true },
  });

  const SECTIONS = ['future_goals', 'success_disclosures', 'failure_disclosures'];
  const kpiDataByTicker = Object.fromEntries(peerTickers.map(t => [t, {}]));

  for (const summary of summaries) {
    const ms = summary.milestones;
    if (!ms || typeof ms !== 'object') continue;
    const meta = callMeta[summary.callId];
    if (!meta) continue;
    const period  = `${meta.fiscal_year}-${meta.quarter}`;
    const kpiData = kpiDataByTicker[meta.company];
    if (!kpiData) continue;

    const seen = new Set();
    for (const section of SECTIONS) {
      const targets = ms[section]?.financial_targets;
      if (!Array.isArray(targets)) continue;
      for (const entry of targets) {
        const abbr = entry.kpi_abbr;
        if (!abbr || !industrySet.has(abbr) || seen.has(abbr)) continue;
        const val = parseFloat(entry.current_value);
        if (isNaN(val)) continue;
        seen.add(abbr);
        if (!kpiData[abbr]) kpiData[abbr] = [];
        kpiData[abbr].push({ period, value: formatKpiValue(val, unitMap[abbr], meta.call_date) });
      }
    }
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

// ── Helper: industry_specific KPI timeseries for last 5 calls ─────────────────
async function getIndustryKpiTimeseries(ticker) {
  // Q4 calls only — each represents a full fiscal year
  const calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker, quarter: 'Q4' },
    select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
    orderBy: [{ fiscal_year: 'desc' }],
    take:    5,
  });
  if (!calls.length) return [];

  const callIds  = calls.map(c => c.id);
  const callMeta = Object.fromEntries(calls.map(c => [c.id, c]));

  const [summaries, industryKpis] = await Promise.all([
    prisma.summaryNew.findMany({
      where:  { callId: { in: callIds } },
      select: { callId: true, milestones: true },
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
  const SECTIONS = ['future_goals', 'success_disclosures', 'failure_disclosures'];

  for (const summary of summaries) {
    const ms = summary.milestones;
    if (!ms || typeof ms !== 'object') continue;
    const meta = callMeta[summary.callId];
    if (!meta) continue;
    const period = `${meta.fiscal_year}-${meta.quarter}`;

    // Deduplicate kpi_abbr within the same quarter (first non-null current_value wins)
    const seen = new Set();
    for (const section of SECTIONS) {
      const targets = ms[section]?.financial_targets;
      if (!Array.isArray(targets)) continue;
      for (const entry of targets) {
        const abbr = entry.kpi_abbr;
        if (!abbr || !industrySet.has(abbr) || seen.has(abbr)) continue;
        const val = parseFloat(entry.current_value);
        if (isNaN(val)) continue;
        seen.add(abbr);
        if (!kpiData[abbr]) kpiData[abbr] = [];
        kpiData[abbr].push({ period, value: formatKpiValue(val, unitMap[abbr], meta.call_date) });
      }
    }
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

    res.json({
      success: true,
      competition: {
        meta: { section_id: 'competition', title: 'Competitive Benchmarking' },
        peers,
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
