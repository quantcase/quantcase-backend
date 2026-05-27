'use strict';

const prisma        = require('../config/prisma');
const { resolveProwessName, fetchAnnualBatch, fetchQuarterlyBatch } = require('../utils/formulaRegistry');

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

function cagr(start, end, years) {
  if (!start || !end || years <= 0 || start <= 0) return null;
  return Math.round((Math.pow(end / start, 1 / years) - 1) * 100);
}

// ─── Financials Singleton ─────────────────────────────────────────────────────

class Financials {
  constructor() {
    if (Financials.instance) return Financials.instance;
    Financials.instance = this;
  }

  async analyze(symbol) {
    // ── 1. Resolve company name (needed for pe_data lookup) ───────────────────
    const companyName = await resolveProwessName(prisma, symbol);

    // ── 2. Fetch all data in parallel ─────────────────────────────────────────
    const now        = Date.now();
    const tenYrsAgo  = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);
    const fiveYrsAgo = new Date(now -  5 * 365 * 24 * 60 * 60 * 1000);

    const [byAnnualAbbr, byQtrAbbr, mktCapRows, peRows, hist10yRows, hist5yRows] = await Promise.all([
      // Annual audited figures (prowess_new_*) — for P&L annual, balance sheet, metrics
      fetchAnnualBatch(prisma, symbol, ALL_ABBRS),
      // Quarterly standalone figures (prowess_qtr_*) — for quarterly P&L and TTM
      fetchQuarterlyBatch(prisma, symbol, ALL_ABBRS),

      // Latest market cap — from nse_equity
      prisma.$queryRaw`
        SELECT market_cap_cr, datetime AS date
        FROM nse_equity
        WHERE symbol = ${symbol} AND market_cap_cr IS NOT NULL
        ORDER BY datetime DESC
        LIMIT 1
      `,

      // PE history — read from nse_equity (symbol keyed)
      prisma.$queryRaw`
        SELECT datetime AS date, pe
        FROM nse_equity
        WHERE symbol = ${symbol} AND pe IS NOT NULL
        ORDER BY datetime ASC
      `,

      // Monthly closes for stock-price CAGR (10 year)
      prisma.$queryRaw`
        SELECT DATE_TRUNC('month', datetime) AS month, AVG(close) AS close
        FROM nse_equity
        WHERE symbol = ${symbol} AND datetime >= ${tenYrsAgo}
        GROUP BY DATE_TRUNC('month', datetime)
        ORDER BY month ASC
      `,

      // Monthly closes for stock-price CAGR (5 year)
      prisma.$queryRaw`
        SELECT DATE_TRUNC('month', datetime) AS month, AVG(close) AS close
        FROM nse_equity
        WHERE symbol = ${symbol} AND datetime >= ${fiveYrsAgo}
        GROUP BY DATE_TRUNC('month', datetime)
        ORDER BY month ASC
      `,
    ]);

    // Annual: Q4 full-year rows from audited annual CSV
    // Quarterly: individual quarter rows from quarterly CSV
    const annualPL    = this._filterAnnual(byAnnualAbbr);
    const quarterlyPL = this._filterQuarterly(byQtrAbbr);
    const mktCapCr    = mktCapRows[0]?.market_cap_cr != null ? parseFloat(mktCapRows[0].market_cap_cr) : null;

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
        metrics:           this._buildMetrics(annualPL, hist10yRows, hist5yRows),
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
    // EBITDA: PAT + FIN_COST + DEP_AMORT + TAX_EXP
    const fcTtm   = ttm('FIN_COST');
    const daTtm   = ttm('DEP_AMORT');
    const taxTtm  = ttm('TAX_EXP');
    const ebitdaTtm = (patTtm != null && fcTtm != null && daTtm != null && taxTtm != null)
      ? r2(patTtm + fcTtm + daTtm + taxTtm)
      : null;

    // EPS TTM: sum of last 4 quarterly EPS_BASIC values
    const epsTtm  = ttm('EPS_BASIC') ?? ttm('EPS_DILUTED');

    return { revenue: revTtm, ebitda: ebitdaTtm, netProfit: patTtm, eps: epsTtm };
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  _buildMetrics(annualPeriods, hist10y, hist5y) {
    const n = annualPeriods.length;
    const revSeries    = annualPeriods.map((p) => p['REV_OP'] ?? p['TOTAL_INCOME']);
    const profitSeries = annualPeriods.map((p) => p['PAT']);
    const nwSeries     = annualPeriods.map((p) => p['NET_WORTH']);

    const salesGrowth3y  = n >= 4  ? cagr(revSeries[n - 4],  revSeries[n - 1],  3) : null;
    const salesGrowth5y  = n >= 6  ? cagr(revSeries[n - 6],  revSeries[n - 1],  5) : null;
    const salesGrowth10y = n >= 11 ? cagr(revSeries[n - 11], revSeries[n - 1], 10) : null;

    const profitGrowth3y  = n >= 4  ? cagr(profitSeries[n - 4],  profitSeries[n - 1],  3) : null;
    const profitGrowth10y = n >= 11 ? cagr(profitSeries[n - 11], profitSeries[n - 1], 10) : null;

    // ROE series = PAT / NET_WORTH
    const roeSeries = annualPeriods.map((p) => {
      const pat = p['PAT'];
      const nw  = p['NET_WORTH'];
      if (pat == null || nw == null || nw === 0) return null;
      return (pat / nw) * 100;
    });
    const avgRoe = (count) => {
      const slice = roeSeries.slice(-count).filter((v) => v != null);
      if (!slice.length) return null;
      return Math.round(slice.reduce((s, v) => s + v, 0) / slice.length);
    };

    // Stock price CAGR from monthly aggregates
    const firstClose = (arr) => arr && arr.length ? parseFloat(arr[0].close) : null;
    const lastClose  = (arr) => arr && arr.length ? parseFloat(arr[arr.length - 1].close) : null;
    const stockCagr10y = cagr(firstClose(hist10y), lastClose(hist10y), 10);
    const stockCagr5y  = cagr(firstClose(hist5y),  lastClose(hist5y),  5);

    // Week 52 change: compare last 2 entries in hist (latest vs ~12 months ago)
    let week52Chg = null;
    if (hist10y && hist10y.length >= 13) {
      const latest = parseFloat(hist10y[hist10y.length - 1].close);
      const year1  = parseFloat(hist10y[hist10y.length - 13].close);
      if (year1 > 0) week52Chg = Math.round(((latest - year1) / year1) * 100);
    }

    return {
      salesGrowth: {
        '3y':  salesGrowth3y,
        '5y':  salesGrowth5y,
        '10y': salesGrowth10y,
        ttm:   null,
      },
      profitGrowth: {
        '3y':  profitGrowth3y,
        '10y': profitGrowth10y,
        ttm:   null,
      },
      roe: {
        '3y':  n >= 3  ? avgRoe(3)  : null,
        '5y':  n >= 5  ? avgRoe(5)  : null,
        '10y': n >= 10 ? avgRoe(10) : null,
        last:  roeSeries.length > 0 ? r2(roeSeries[roeSeries.length - 1]) : null,
      },
      stockPriceCagr: {
        '1y':  week52Chg,
        '3y':  null,
        '5y':  stockCagr5y,
        '10y': stockCagr10y,
      },
    };
  }

  // ── Valuation ─────────────────────────────────────────────────────────────

  _buildValuation(byAbbr, mktCapCr, peRows) {
    const mktCapAbs = mktCapCr != null ? mktCapCr * 1e7 : null;

    // Latest PE from pe_data
    const latestPe = peRows.length > 0 ? r2(parseFloat(peRows[peRows.length - 1].pe)) : null;

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
