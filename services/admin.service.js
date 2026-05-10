'use strict';

const prisma        = require('../config/prisma');
const { isBFSI }    = require('../utils/industryClassifier');
const {
  fetchEarningsTimeSeriesBatch, fetchDerivedBatch,
  fetchStockCagr, fetchStockPeCagr,
  fetchIndustryCagr, fetchIndustryPeCagr,
  fetchEarningsLatest, fetchEarningsCagr,
} = require('../utils/formulaRegistry');

// ─── Constants ────────────────────────────────────────────────────────────────

const INDUSTRY_RAW_ABBRS = [
  'REV_OP', 'TOTAL_INCOME', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
  'EMP_EXP', 'OTH_EXP', 'FIN_COST', 'DEP_AMORT',
  'PBT', 'PAT', 'TOTAL_ASSETS', 'CURR_LIAB',
];

const FINANCIAL_STRENGTH_RAW_ABBRS = [
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

const KPI_LABELS = {
  REV_OP:      'Revenue from Operations',
  TOTAL_INCOME:'Total Income',
  COST_MAT:    'Cost of Materials Consumed',
  PURCH_STOCK: 'Purchases of Stock-in-Trade',
  INV_CHG:     'Changes in Inventories',
  EMP_EXP:     'Employee Benefits Expense',
  OTH_EXP:     'Other Expenses',
  FIN_COST:    'Finance Costs (Interest)',
  DEP_AMORT:   'Depreciation & Amortisation',
  PBT:         'Profit Before Tax',
  PAT:         'Profit After Tax',
  TOTAL_ASSETS:'Total Assets',
  CURR_LIAB:   'Current Liabilities',
  CFO:         'Cash Flow from Operations',
  TRADE_RECV:  'Trade Receivables',
  TRADE_PAY:   'Trade Payables',
  INVENTORY:   'Inventories',
  DEBT_LT:     'Long-term Debt',
  DEBT_ST:     'Short-term Debt',
  CASH_EQUIV:  'Cash & Cash Equivalents',
  EQ_SHARE_CAP:'Equity Share Capital',
  RES_SURPLUS: 'Reserves & Surplus',
  ASSET_PPE:   'Property, Plant & Equipment (net)',
  ASSET_CWIP:  'Capital Work-in-Progress',
  PROV_CONT:   'Provisions & Contingencies (BFSI)',
  DIV_PAYOUT:  'Dividend Payout',
  EBIT:        'EBIT',
  EBIT_MARGIN: 'EBIT Margin',
  ROCE:        'Return on Capital Employed',
  ROA:         'Return on Assets',
  ROE:         'Return on Equity',
  CAPEX:       'Capital Expenditure',
  FCF:         'Free Cash Flow',
};

const FORMULAE = {
  EBIT:        'REV_OP − (COST_MAT + PURCH_STOCK + INV_CHG) − EMP_EXP − DEP_AMORT − OTH_EXP',
  PPOP:        'REV_OP − EMP_EXP − DEP_AMORT − OTH_EXP  [BFSI: COST_MAT/PURCH_STOCK/INV_CHG excluded]',
  EBIT_MARGIN: 'EBIT / REV_OP × 100',
  ROCE:        '(PBT + FIN_COST) / (TOTAL_ASSETS − CURR_LIAB) × 100',
  ROA:         'PAT / TOTAL_ASSETS × 100',
  ROE:         'PAT / (EQ_SHARE_CAP + RES_SURPLUS) × 100',
  CAPEX:       'ASSET_PPE + ASSET_CWIP  [ASSET_CWIP = 0 when missing]',
  FCF:         'CFO − CAPEX',
  FCF_BFSI:    'CFO − CAPEX − PROV_CONT  [PROV_CONT = 0 when missing]',
  CAGR:        '((latestValue / firstValue) ^ (1 / spanYears) − 1) × 100',
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function nullReason(abbr, raw, derived, bfsi) {
  const missing  = [];
  const zeroDenom = [];
  const r = k => raw[k] ?? null;
  const d = k => derived[k] ?? null;

  switch (abbr) {
    case 'EBIT':
      for (const k of ['REV_OP', 'EMP_EXP', 'DEP_AMORT', 'OTH_EXP']) {
        if (r(k) == null) missing.push(k);
      }
      break;
    case 'EBIT_MARGIN':
      if (d('EBIT') == null) missing.push('EBIT (derived)');
      if (r('REV_OP') == null) missing.push('REV_OP');
      else if (r('REV_OP') === 0) zeroDenom.push('REV_OP = 0');
      break;
    case 'ROCE':
      if (bfsi) return { note: 'ROCE is not calculated for BFSI — always null' };
      for (const k of ['PBT', 'FIN_COST', 'TOTAL_ASSETS', 'CURR_LIAB']) {
        if (r(k) == null) missing.push(k);
      }
      if (r('TOTAL_ASSETS') != null && r('CURR_LIAB') != null) {
        if ((r('TOTAL_ASSETS') - r('CURR_LIAB')) === 0) zeroDenom.push('TOTAL_ASSETS − CURR_LIAB = 0  (Capital Employed is zero)');
      }
      break;
    case 'ROA':
      for (const k of ['PAT', 'TOTAL_ASSETS']) { if (r(k) == null) missing.push(k); }
      if (r('TOTAL_ASSETS') === 0) zeroDenom.push('TOTAL_ASSETS = 0');
      break;
    case 'ROE':
      for (const k of ['PAT', 'EQ_SHARE_CAP', 'RES_SURPLUS']) { if (r(k) == null) missing.push(k); }
      if (r('EQ_SHARE_CAP') != null && r('RES_SURPLUS') != null) {
        if ((r('EQ_SHARE_CAP') + r('RES_SURPLUS')) === 0) zeroDenom.push('EQ_SHARE_CAP + RES_SURPLUS = 0');
      }
      break;
    case 'CAPEX':
      if (r('ASSET_PPE') == null) missing.push('ASSET_PPE');
      break;
    case 'FCF':
      if (r('CFO') == null) missing.push('CFO');
      if (d('CAPEX') == null) missing.push('CAPEX (derived)');
      break;
  }

  if (!missing.length && !zeroDenom.length) return null;
  return {
    ...(missing.length   && { missing_inputs: missing }),
    ...(zeroDenom.length && { zero_denominators: zeroDenom }),
  };
}

function q4Only(batch) {
  return Object.fromEntries(
    Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
  );
}

function periodLookup(batch) {
  const map = {};
  for (const [abbr, series] of Object.entries(batch)) {
    for (const entry of series) {
      (map[entry.period] ??= {})[abbr] = entry.value;
    }
  }
  return map;
}

function latestQ4(series) {
  const q4 = series.filter(s => s.quarter === 'Q4');
  return q4.length ? q4[q4.length - 1] : null;
}

function buildMetrics({ rawAbbrs, rawBatch, derivedBatch, bfsi }) {
  const q4Raw     = q4Only(rawBatch);
  const q4Derived = q4Only(derivedBatch);
  const rawByPeriod     = periodLookup(q4Raw);
  const derivedByPeriod = periodLookup(q4Derived);

  const metrics = [];

  for (const abbr of rawAbbrs) {
    const entry = latestQ4(rawBatch[abbr] ?? []);
    metrics.push({
      abbr, label: KPI_LABELS[abbr] ?? abbr, type: 'raw',
      value: entry?.value ?? null, period: entry?.period ?? null,
      status: entry?.value != null ? 'ok' : 'null',
    });
  }

  const DERIVED_ORDER = ['EBIT', 'EBIT_MARGIN', 'ROCE', 'ROA', 'ROE', 'CAPEX', 'FCF'];
  for (const abbr of DERIVED_ORDER) {
    const series = q4Derived[abbr];
    if (!series) continue;
    const entry   = series.length ? series[series.length - 1] : null;
    const formula = abbr === 'EBIT' ? (bfsi ? FORMULAE.PPOP : FORMULAE.EBIT)
                  : abbr === 'FCF'  ? (bfsi ? FORMULAE.FCF_BFSI : FORMULAE.FCF)
                  : FORMULAE[abbr] ?? null;
    const label   = abbr === 'EBIT' && bfsi ? 'PPOP (Pre-Provisioning Operating Profit)' : KPI_LABELS[abbr] ?? abbr;

    const metric = {
      abbr, label, type: 'derived', formula,
      value: entry?.value ?? null, period: entry?.period ?? null,
      status: entry?.value != null ? 'ok' : 'null',
    };

    if (metric.status === 'null' && entry) {
      const raw     = rawByPeriod[entry.period]     ?? {};
      const derived = derivedByPeriod[entry.period] ?? {};
      const reason  = nullReason(abbr, raw, derived, bfsi);
      if (reason) metric.null_reason = reason;
    }

    metrics.push(metric);
  }

  return metrics;
}

function cagrMetric({ abbr, label, source, result }) {
  return {
    abbr, label, type: 'computed', formula: FORMULAE.CAGR, source,
    value: result?.value ?? null,
    ...(result?.type        && { computation_type: result.type }),
    ...(result?.spanYears   && { span_years: result.spanYears }),
    ...(result?.periodsUsed && { periods_used: result.periodsUsed }),
    ...(result?.firstValue  && { first_value: result.firstValue }),
    ...(result?.latestValue && { latest_value: result.latestValue }),
    ...(result?.latestPe    && { latest_pe: result.latestPe }),
    ...(result?.avgPe       && { avg_pe: result.avgPe }),
    ...(result?.note        && { note: result.note }),
    status: result?.value != null ? 'ok' : 'null',
  };
}

async function getSubjectSummaries(ticker) {
  const rows = await prisma.summaryNew.findMany({
    where:   { callId: { startsWith: ticker } },
    orderBy: { callId: 'desc' },
    take:    2,
  });
  return rows.reverse();
}

async function getAutoPeerTickers(subjectTicker, industry) {
  if (!industry || industry === 'Unknown Industry') return [];
  const allPeers = await prisma.summaryNew.findMany({
    where: {
      industryAnalysis: { path: ['industry'], equals: industry },
      NOT: { callId: { startsWith: subjectTicker } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const seen = new Map();
  for (const s of allPeers) {
    const ticker = s.callId.split('_FY')[0];
    if (!seen.has(ticker)) seen.set(ticker, true);
    if (seen.size >= 2) break;
  }
  return [...seen.keys()];
}

// ─── Main service function ────────────────────────────────────────────────────

async function computeOpportunityStats(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error(`Earnings call "${callId}" not found`);
    err.status = 404;
    throw err;
  }

  const subjectTicker    = call.company;
  const subjectSummaries = await getSubjectSummaries(subjectTicker);
  const latestSummary    = subjectSummaries[subjectSummaries.length - 1];
  const industry = latestSummary?.industryAnalysis?.industry || call.basic_industry || 'Unknown Industry';
  const bfsi     = isBFSI(industry);

  const [
    industryRawBatch, fsRawBatch, derivedBatch,
    stockEps, stockPe, industryEps, industryPe,
    custLatest, custCagr, peerTickers,
  ] = await Promise.all([
    fetchEarningsTimeSeriesBatch(prisma, subjectTicker, INDUSTRY_RAW_ABBRS),
    fetchEarningsTimeSeriesBatch(prisma, subjectTicker, FINANCIAL_STRENGTH_RAW_ABBRS),
    fetchDerivedBatch(prisma, subjectTicker, bfsi),
    fetchStockCagr(prisma, subjectTicker, 'EPS_BASIC'),
    fetchStockPeCagr(prisma, subjectTicker),
    industry !== 'Unknown Industry' ? fetchIndustryCagr(prisma, industry, 'EPS_BASIC') : Promise.resolve(null),
    industry !== 'Unknown Industry' ? fetchIndustryPeCagr(prisma, industry)             : Promise.resolve(null),
    fetchEarningsLatest(prisma, subjectTicker, 'CUST'),
    fetchEarningsCagr(prisma, subjectTicker, 'CUST'),
    getAutoPeerTickers(subjectTicker, industry),
  ]);

  let resolvedCustLatest = custLatest;
  let custSource = 'quarterly earnings (summaryNew.kpis)';
  if (custLatest.value == null) {
    for (const s of [...subjectSummaries].reverse()) {
      const kpis  = s.clientTraction?.customer_growth?.kpis ?? [];
      const match = kpis.find(k => k.kpi_abbr === 'CUST' && k.value != null);
      if (match) {
        resolvedCustLatest = { value: match.value, abbrUsed: 'CUST', period: s.callId, type: 'transcript_fallback' };
        custSource = `transcript fallback (${s.callId})`;
        break;
      }
    }
  }

  const industryMetrics = buildMetrics({ rawAbbrs: INDUSTRY_RAW_ABBRS, rawBatch: industryRawBatch, derivedBatch, bfsi });

  const competitionMetrics = [
    cagrMetric({ abbr: 'stock_eps_cagr',    label: 'Stock EPS CAGR',            source: 'summaryNew.kpis → EPS_BASIC',                       result: stockEps }),
    cagrMetric({ abbr: 'stock_pe_cagr',     label: 'Stock P/E CAGR',            source: 'pe_data table',                                      result: stockPe }),
    industryEps ? cagrMetric({ abbr: 'industry_eps_cagr', label: 'Industry EPS CAGR (avg)', source: 'summaryNew.kpis → EPS_BASIC (all industry tickers)', result: industryEps }) : null,
    industryPe  ? cagrMetric({ abbr: 'industry_pe_cagr',  label: 'Industry P/E CAGR (avg)', source: 'pe_data table (all industry tickers)',               result: industryPe  }) : null,
  ].filter(Boolean);

  const fsMetrics = buildMetrics({ rawAbbrs: FINANCIAL_STRENGTH_RAW_ABBRS, rawBatch: fsRawBatch, derivedBatch, bfsi });

  const custMetrics = [
    { abbr: 'CUST', label: 'Number of Customers (latest)', type: 'raw', source: custSource, value: resolvedCustLatest.value, period: resolvedCustLatest.period, status: resolvedCustLatest.value != null ? 'ok' : 'null' },
    cagrMetric({ abbr: 'CUST_CAGR', label: 'Customer Count CAGR', source: 'summaryNew.kpis → CUST', result: custCagr }),
  ];

  return {
    meta: { callId, subjectTicker, industry, bfsi },
    sections: [
      { id: 'industry',           label: 'Industry Overview',    note: 'Q4 (annual) snapshots only — same data injected into LLM prompt',             peers_discovered: peerTickers, metrics: industryMetrics },
      { id: 'competition',        label: 'Competition',          note: 'Computed CAGR values injected into LLM prompt',                               metrics: competitionMetrics },
      { id: 'financial_strength', label: 'Financial Strength',   note: 'Q4 (annual) snapshots — latest value shown; full 10Q timeseries also injected into prompt', metrics: fsMetrics },
      { id: 'customer_traction',  label: 'Customer Traction',    note: 'Latest customer count + CAGR injected into LLM prompt',                      metrics: custMetrics },
    ],
  };
}

module.exports = { computeOpportunityStats };
