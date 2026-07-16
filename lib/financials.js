'use strict';

const prisma        = require('../config/prisma');
const { resolveProwessName, fetchAnnualBatch, fetchQuarterlyBatch, resolveMetric } = require('../utils/formulaRegistry');
const { fetchMarketSnapshot, fetchPeTimeSeries, fetchMonthlyClose } = require('../utils/formulaRegistry/dataFetcherMarket');
const { cagr: mathCagr } = require('../utils/formulaRegistry/math');

const ALL_ABBRS = [
  'REV_OP', 'TOTAL_INCOME', 'TOTAL_OPEX', 'EBIT', 'OTH_INC',
  'FIN_COST', 'DEP_AMORT', 'PBT', 'PAT', 'EPS_BASIC', 'EPS_DILUTED', 'TAX_EXP',
  'EQ_SHARE_CAP', 'RES_SURPLUS', 'BORR_TOTAL', 'DEBT_LT', 'DEBT_ST',
  'TOTAL_LIAB', 'ASSET_PPE', 'ASSET_CWIP', 'INV_NONCURR', 'TOTAL_ASSETS',
  'CFO', 'CFI', 'CFF', 'NET_WORTH',
  'CURR_ASSETS', 'CURR_LIAB', 'OTH_ASSET_NC', 'PROV_LT', 'PROV_ST',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

function pct(num, den) {
  if (!num || !den) return null;
  return Math.round((num / den) * 100);
}

function roundCagr(s, e, y) {
  const v = mathCagr(s, e, y);
  return v != null ? Math.round(v) : null;
}

const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// Every windowed*/ttmGrowthField helper below returns { value, error }: `value`
// is the normal number|null the response schema always had, and `error` (null
// when the value is fine) is a human-readable reason surfaced separately —
// see assembleWindowed() — instead of overloading `value` with a string.

// CAGR over an ascending annual series, routed through the registry's windowed
// CAGR entries (e.g. REV_CAGR_5Y). A window needs `windowYears + 1` annual points
// (start + end); when the company doesn't have that much history yet, report how
// much it actually has instead of silently computing a shorter, mislabeled span.
function windowedCagr(series, windowYears, metricId) {
  const pts = series.filter((s) => s.value != null);
  if (pts.length < windowYears + 1) {
    return { value: null, error: pts.length >= 2 ? `Only ${pts.length - 1}Y of data available` : null };
  }
  return { value: r2(resolveMetric(metricId, { series }).value), error: null };
}

// Multi-year average over an ascending annual series (e.g. ROE_5Y_AVG), routed
// through the registry. A window needs `windowYears` annual points.
function windowedAverage(series, windowYears, metricId) {
  const pts = series.filter((s) => s.value != null);
  if (pts.length < windowYears) {
    return { value: null, error: pts.length >= 1 ? `Only ${pts.length}Y of data available` : null };
  }
  return { value: r2(resolveMetric(metricId, { series }).value), error: null };
}

// Stock price CAGR over the last `windowYears`, sliced by date out of one
// long-lookback monthly-close fetch. Filters null-close bars (recently-listed
// tickers carry leading null-close months before trading actually started) —
// using them unfiltered silently turns the CAGR into NaN, which then serializes
// as JSON null and looks identical to "no data".
function windowedStockCagr(monthlyClose, windowYears) {
  const bars = (monthlyClose || []).filter((r) => r.close != null);
  if (bars.length < 2) return { value: null, error: null };

  // Anchor the cutoff to the latest bar's own month (not "today") so it lands
  // exactly on a month boundary — anchoring to Date.now() instead would usually
  // fall mid-month and exclude the correct boundary bar, quietly shortening the
  // window by up to a month.
  const last      = bars[bars.length - 1];
  const sinceDate = new Date(last.month);
  sinceDate.setUTCFullYear(sinceDate.getUTCFullYear() - windowYears);

  const withinWindow = bars.filter((r) => new Date(r.month) >= sinceDate);
  const first         = withinWindow[0] ?? bars[0];

  const elapsedYears = (new Date(last.month) - new Date(first.month)) / ONE_YEAR_MS;
  if (elapsedYears < windowYears * 0.9) {
    return {
      value: null,
      error: elapsedYears > 0 ? `Only ${Math.round(elapsedYears * 10) / 10}Y of data available` : null,
    };
  }
  // Annualize over the actual elapsed span, not the nominal window — keeps the
  // math correct even when it's off by a few days from the requested window.
  return { value: roundCagr(parseFloat(first.close), parseFloat(last.close), elapsedYears), error: null };
}

// Sum of exactly 4 consecutive quarters from a registry-shaped quarterly abbr
// array (ascending, one entry per known period). Requires all 4 to be non-null —
// a partial window (e.g. only 1 of the 4 "prior" quarters exists) would silently
// understate the prior-year TTM and produce a misleading growth rate.
function sumQuarters(byAbbr, abbr, offset) {
  const arr = byAbbr[abbr];
  if (!arr) return null;
  const end = arr.length - offset;
  if (end < 4) return null;
  const vals = arr.slice(end - 4, end).map((r) => (r.value != null ? r2(r.value) : null));
  if (vals.some((v) => v == null)) return null;
  return r2(vals.reduce((s, v) => s + v, 0));
}

// TTM growth = CAGR of a 2-point [priorTTM, currentTTM] series over 1 year —
// mathematically identical to a YoY growth rate, so it reuses the registry's
// plain (unwindowed) CAGR entry instead of a bespoke formula.
function ttmGrowthField(curr, prior, cagrEntryId, quartersAvailable) {
  if (curr != null && prior != null) {
    return { value: r2(resolveMetric(cagrEntryId, { series: [{ value: prior }, { value: curr }] }).value), error: null };
  }
  return {
    value: null,
    error: quartersAvailable > 0 ? `Only ${quartersAvailable} quarter${quartersAvailable === 1 ? '' : 's'} of data available` : null,
  };
}

// Assembles one salesGrowth/profitGrowth/roe/stockPriceCagr response bucket:
// every key keeps its plain number|null value (unchanged response schema), and
// an `error` sibling collects the reasons for whichever keys came back null —
// omitted entirely when nothing needs explaining.
function assembleWindowed(entries) {
  const out = {};
  const error = {};
  for (const [key, res] of entries) {
    out[key] = res.value;
    if (res.error) error[key] = res.error;
  }
  if (Object.keys(error).length) out.error = error;
  return out;
}

// ─── Financials Singleton ─────────────────────────────────────────────────────

class Financials {
  constructor() {
    if (Financials.instance) return Financials.instance;
    Financials.instance = this;
  }

  async analyze(symbol) {
    // ── 1. Resolve company name ───────────────────────────────────────────────
    const companyName = await resolveProwessName(prisma, symbol);

    // ── 2. Fetch all data in parallel ─────────────────────────────────────────
    const now       = Date.now();
    const tenYrsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    // Longest lookback only — 1y/3y/5y windows are sliced from this by date,
    // so a young stock reports exactly how much history it actually has.
    const [byAnnualAbbr, byQtrAbbr, marketSnap, peRows, monthlyCloseRows] = await Promise.all([
      fetchAnnualBatch(prisma, symbol, ALL_ABBRS),
      fetchQuarterlyBatch(prisma, symbol, ALL_ABBRS),
      fetchMarketSnapshot(prisma, symbol),
      fetchPeTimeSeries(prisma, symbol),
      fetchMonthlyClose(prisma, symbol, { since: tenYrsAgo }),
    ]);

    // Annual: Q4 full-year rows from audited annual CSV
    // Quarterly: individual quarter rows from quarterly CSV
    const annualPL    = this._filterAnnual(byAnnualAbbr);
    const quarterlyPL = this._filterQuarterly(byQtrAbbr);
    const mktCapCr    = marketSnap?.market_cap_cr ?? null;

    return {
      symbol,
      exchange:  'NSE',
      currency:  'INR',
      unit:      'INR_CRORES',
      timestamp: new Date().toISOString(),

      standardized: {
        quarterly:         this._buildPL(quarterlyPL, false),
        annual:            this._buildPL(annualPL, true),
        balanceSheet:      this._buildBalanceSheet(annualPL, quarterlyPL),
        cashFlow:          this._buildCashFlow(annualPL, false),
        cashFlowQuarterly: this._buildCashFlow(quarterlyPL, true),
        ttm:               this._buildTTM(byQtrAbbr, mktCapCr),
        metrics:           this._buildMetrics(annualPL, byQtrAbbr, monthlyCloseRows),
        valuation:         this._buildValuation(byAnnualAbbr, mktCapCr, peRows),
      },
    };
  }

  // ── Period helpers ─────────────────────────────────────────────────────────

  // Prowess stores Q4 as the full-year figure; use those for annual view
  _filterAnnual(byAbbr) {
    // Collect all unique (fiscal_year, quarter) pairs that have Q4 entries
    const periods = new Set();
    for (const rows of Object.values(byAbbr)) {
      for (const r of rows) {
        if (r.quarter === 'Q4') periods.add(`${r.fiscal_year}|${r.quarter}`);
      }
    }
    // Build per-period objects sorted by fiscal year
    return [...periods]
      .sort()
      .map((key) => {
        const [fiscal_year, quarter] = key.split('|');
        const obj = { fiscal_year, quarter, _label: this._fyLabel(fiscal_year) };
        for (const [abbr, rows] of Object.entries(byAbbr)) {
          const r = rows.find((x) => x.fiscal_year === fiscal_year && x.quarter === quarter);
          if (r) obj[abbr] = this._toCr(r);
        }
        return obj;
      });
  }

  _filterQuarterly(byAbbr) {
    const periods = new Set();
    for (const rows of Object.values(byAbbr)) {
      for (const r of rows) periods.add(`${r.fiscal_year}|${r.quarter}`);
    }
    return [...periods]
      .sort()
      .map((key) => {
        const [fiscal_year, quarter] = key.split('|');
        const obj = { fiscal_year, quarter, _label: `${quarter} ${fiscal_year}` };
        for (const [abbr, rows] of Object.entries(byAbbr)) {
          const r = rows.find((x) => x.fiscal_year === fiscal_year && x.quarter === quarter);
          if (r) obj[abbr] = this._toCr(r);
        }
        return obj;
      });
  }

  _fyLabel(fiscal_year) {
    // fiscal_year like "FY2024" → "FY24"
    if (!fiscal_year) return null;
    const m = fiscal_year.match(/\d+/);
    return m ? `FY${m[0].slice(-2)}` : fiscal_year;
  }

  _toCr(row) {
    if (!row) return null;
    return r2(row.value);
  }

  // ── P&L ───────────────────────────────────────────────────────────────────

  _buildPL(periods, isAnnual) {
    if (!periods.length) return { periods: [], rows: [] };
    const labels = periods.map((p) => p._label);

    const pick = (abbr) => periods.map((p) => p[abbr] ?? null);

    const revenues  = pick('REV_OP').map((v, i) => v ?? periods[i]['TOTAL_INCOME'] ?? null);
    const expenses  = pick('TOTAL_OPEX');
    const opProfit  = periods.map((p) => {
      const rev = p['REV_OP'] ?? p['TOTAL_INCOME'];
      const exp = p['TOTAL_OPEX'];
      if (rev != null && exp != null) return r2(rev - exp);
      return p['EBIT'] ?? null;
    });
    const opm       = periods.map((p, i) => pct(opProfit[i], revenues[i]));
    const interest  = pick('FIN_COST');
    const deprec    = pick('DEP_AMORT');
    const pbt       = pick('PBT');
    const netProfit = pick('PAT');
    const eps       = pick('EPS_BASIC').map((v, i) => v ?? pick('EPS_DILUTED')[i]);
    const otherInc  = pick('OTH_INC');

    const rows = isAnnual
      ? [
          { key: 'revenue',         label: 'Sales',              values: revenues },
          { key: 'expenses',        label: 'Expenses',           values: expenses },
          { key: 'operatingProfit', label: 'Operating Profit',   values: opProfit, highlight: true },
          { key: 'opm',             label: 'OPM %',              values: opm,      format: 'percent' },
          { key: 'pbt',             label: 'Profit Before Tax',  values: pbt },
          { key: 'netProfit',       label: 'Net Profit',         values: netProfit, highlight: true },
          { key: 'eps',             label: 'EPS',                values: eps },
        ]
      : [
          { key: 'revenue',         label: 'Sales',              values: revenues, meta: { expandable: true } },
          { key: 'expenses',        label: 'Expenses',           values: expenses, meta: { expandable: true } },
          { key: 'operatingProfit', label: 'Operating Profit',   values: opProfit, highlight: true },
          { key: 'opm',             label: 'OPM %',              values: opm,      format: 'percent' },
          { key: 'otherIncome',     label: 'Other Income',       values: otherInc },
          { key: 'interest',        label: 'Interest',           values: interest },
          { key: 'depreciation',    label: 'Depreciation',       values: deprec },
          { key: 'pbt',             label: 'Profit Before Tax',  values: pbt,      highlight: true },
          { key: 'netProfit',       label: 'Net Profit',         values: netProfit, highlight: true },
          { key: 'eps',             label: 'EPS',                values: eps },
        ];

    return { periods: labels, rows };
  }

  // ── Balance Sheet ─────────────────────────────────────────────────────────

  _buildBalanceSheet(annualPeriods, quarterlyPeriods) {
    const build = (periods) => {
      if (!periods.length) return { periods: [], rows: [] };
      const labels = periods.map((p) => p._label);
      const pick   = (abbr) => periods.map((p) => p[abbr] ?? null);

      const totalAssets = periods.map((p) => {
        if (p['TOTAL_ASSETS'] != null) return p['TOTAL_ASSETS'];
        const curr = p['CURR_ASSETS'];
        const ppe  = p['ASSET_PPE'];
        const cwip = p['ASSET_CWIP'];
        const inv  = p['INV_NONCURR'];
        const oth  = p['OTH_ASSET_NC'];
        const parts = [curr, ppe, cwip, inv, oth].filter((v) => v != null);
        return parts.length >= 2 ? r2(parts.reduce((s, v) => s + v, 0)) : null;
      });

      const totalLiab = periods.map((p) => {
        if (p['TOTAL_LIAB'] != null) return p['TOTAL_LIAB'];
        const curr  = p['CURR_LIAB'];
        const borr  = p['BORR_TOTAL'] ?? (((p['DEBT_LT'] ?? 0) + (p['DEBT_ST'] ?? 0)) || null);
        const provLt = p['PROV_LT'];
        const provSt = p['PROV_ST'];
        const parts = [curr, borr, provLt, provSt].filter((v) => v != null);
        return parts.length >= 2 ? r2(parts.reduce((s, v) => s + v, 0)) : null;
      });

      return {
        periods: labels,
        rows: [
          { key: 'equityCapital',    label: 'Equity Capital',    values: pick('EQ_SHARE_CAP') },
          { key: 'reserves',         label: 'Reserves',          values: pick('RES_SURPLUS') },
          { key: 'borrowings',       label: 'Borrowings',
            values: periods.map((p) => p['BORR_TOTAL'] ?? (((p['DEBT_LT'] ?? 0) + (p['DEBT_ST'] ?? 0)) || null)) },
          { key: 'totalLiabilities', label: 'Total Liabilities', values: totalLiab, highlight: true },
          { key: 'fixedAssets',      label: 'Fixed Assets',      values: pick('ASSET_PPE') },
          { key: 'cwip',             label: 'CWIP',              values: pick('ASSET_CWIP') },
          { key: 'investments',      label: 'Investments',       values: pick('INV_NONCURR') },
          { key: 'totalAssets',      label: 'Total Assets',      values: totalAssets, highlight: true },
        ],
      };
    };
    return { annual: build(annualPeriods), quarterly: build(quarterlyPeriods) };
  }

  // ── Cash Flow ─────────────────────────────────────────────────────────────

  _buildCashFlow(periods, isQuarterly) {
    if (!periods.length) return { periods: [], rows: [] };
    const labels = periods.map((p) => p._label);
    const pick   = (abbr) => periods.map((p) => p[abbr] ?? null);
    return {
      periods: labels,
      rows: [
        { key: 'operatingCF',  label: 'Cash from Operations', values: pick('CFO'),  highlight: true },
        { key: 'investingCF',  label: 'Cash from Investing',  values: pick('CFI') },
        { key: 'financingCF',  label: 'Cash from Financing',  values: pick('CFF') },
      ],
    };
  }

  // ── TTM ──────────────────────────────────────────────────────────────────

  _buildTTM(byAbbr, mktCapCr) {
    // Sum last 4 quarterly entries for each KPI
    const ttm = (abbr) => {
      const arr = byAbbr[abbr];
      if (!arr || arr.length === 0) return null;
      const last4 = arr.slice(-4);
      const vals  = last4.map((r) => this._toCr(r)).filter((v) => v != null);
      if (vals.length === 0) return null;
      return r2(vals.reduce((s, v) => s + v, 0));
    };

    const revTtm  = ttm('REV_OP') ?? ttm('TOTAL_INCOME');
    const patTtm  = ttm('PAT');
    const taxTtm  = ttm('TAX_EXP');
    const pbtTtm  = ttm('PBT') ?? (patTtm != null && taxTtm != null ? r2(patTtm + taxTtm) : null);
    const fcTtm   = ttm('FIN_COST');
    const daTtm   = ttm('DEP_AMORT');
    const ebitdaTtm = r2(resolveMetric('EBITDA', { kpiMap: { PBT: pbtTtm, FIN_COST: fcTtm, DEP_AMORT: daTtm } }).value);
    const epsTtm  = ttm('EPS_BASIC') ?? ttm('EPS_DILUTED');

    return { revenue: revTtm, ebitda: ebitdaTtm, netProfit: patTtm, eps: epsTtm };
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  _buildMetrics(annualPeriods, quarterlyByAbbr, monthlyClose) {
    // Ascending {value, fiscal_year} series — same shape the registry's cagr/
    // average resolvers expect (see screener.controller.js's epsSeriesAsc).
    const revSeries    = annualPeriods.map((p) => ({ value: p['REV_OP'] ?? p['TOTAL_INCOME'] ?? null, fiscal_year: p.fiscal_year }));
    const profitSeries = annualPeriods.map((p) => ({ value: p['PAT'] ?? null, fiscal_year: p.fiscal_year }));
    const roeSeries     = annualPeriods.map((p) => {
      const pat = p['PAT'], nw = p['NET_WORTH'];
      const value = (pat != null && nw != null && nw !== 0) ? (pat / nw) * 100 : null;
      return { value, fiscal_year: p.fiscal_year };
    });

    // TTM growth: current trailing-4-quarter sum vs the prior trailing-4-quarter sum.
    const revTtmCurr    = sumQuarters(quarterlyByAbbr, 'REV_OP', 0) ?? sumQuarters(quarterlyByAbbr, 'TOTAL_INCOME', 0);
    const revTtmPrior   = sumQuarters(quarterlyByAbbr, 'REV_OP', 4) ?? sumQuarters(quarterlyByAbbr, 'TOTAL_INCOME', 4);
    const patTtmCurr    = sumQuarters(quarterlyByAbbr, 'PAT', 0);
    const patTtmPrior   = sumQuarters(quarterlyByAbbr, 'PAT', 4);
    const quartersAvail = (quarterlyByAbbr['REV_OP'] ?? quarterlyByAbbr['TOTAL_INCOME'] ?? []).filter((r) => r.value != null).length;

    return {
      salesGrowth: assembleWindowed([
        ['3y',  windowedCagr(revSeries, 3, 'REV_CAGR_3Y')],
        ['5y',  windowedCagr(revSeries, 5, 'REV_CAGR_5Y')],
        ['10y', windowedCagr(revSeries, 10, 'REV_CAGR_10Y')],
        ['ttm', ttmGrowthField(revTtmCurr, revTtmPrior, 'REV_CAGR', quartersAvail)],
      ]),
      profitGrowth: assembleWindowed([
        ['3y',  windowedCagr(profitSeries, 3, 'PAT_CAGR_3Y')],
        ['5y',  windowedCagr(profitSeries, 5, 'PAT_CAGR_5Y')],
        ['10y', windowedCagr(profitSeries, 10, 'PAT_CAGR_10Y')],
        ['ttm', ttmGrowthField(patTtmCurr, patTtmPrior, 'PAT_CAGR', quartersAvail)],
      ]),
      roe: {
        ...assembleWindowed([
          ['3y',  windowedAverage(roeSeries, 3, 'ROE_3Y_AVG')],
          ['5y',  windowedAverage(roeSeries, 5, 'ROE_5Y_AVG')],
          ['10y', windowedAverage(roeSeries, 10, 'ROE_10Y_AVG')],
        ]),
        last: roeSeries.length && roeSeries.at(-1).value != null ? r2(roeSeries.at(-1).value) : null,
      },
      stockPriceCagr: assembleWindowed([
        ['1y',  windowedStockCagr(monthlyClose, 1)],
        ['3y',  windowedStockCagr(monthlyClose, 3)],
        ['5y',  windowedStockCagr(monthlyClose, 5)],
        ['10y', windowedStockCagr(monthlyClose, 10)],
      ]),
    };
  }

  // ── Valuation ─────────────────────────────────────────────────────────────

  _buildValuation(byAbbr, mktCapCr, peRows) {
    const mktCapAbs = mktCapCr != null ? mktCapCr * 1e7 : null;

    const latestPe = peRows.length > 0 ? r2(peRows[peRows.length - 1].pe) : null;

    // P/B = marketCap / netWorth
    const latestNwCr = (() => {
      const arr = byAbbr['NET_WORTH'];
      if (!arr || !arr.length) return null;
      return this._toCr(arr[arr.length - 1]);
    })();
    const pbRatio = mktCapCr != null && latestNwCr != null && latestNwCr !== 0
      ? r2(mktCapCr / latestNwCr) : null;

    // Latest EPS
    const epsArr = byAbbr['EPS_BASIC'] ?? byAbbr['EPS_DILUTED'];
    const latestEps = epsArr && epsArr.length ? r2(parseFloat(epsArr[epsArr.length - 1].value)) : null;

    return {
      marketCap:       mktCapCr,
      enterpriseValue: null,
      peRatio:         latestPe,
      forwardPE:       null,
      pbRatio,
      evToEbitda:      null,
      evToRevenue:     null,
      dividendYield:   null,
      bookValue:       latestNwCr,
      eps:             latestEps,
    };
  }
}

const financials = new Financials();
module.exports = financials;
