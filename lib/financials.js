'use strict';

const YahooFinance = require('yahoo-finance2').default;

const INR_CRORE = 1e7; // 1 crore = 10,000,000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toCrores(v) {
  if (v == null || isNaN(v)) return null;
  return Math.round(v / INR_CRORE * 100) / 100;
}

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

/** Format a Date to "Mon YYYY", e.g. "Dec 2022" */
function fmtPeriod(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** Format fiscal year label from date, e.g. "FY25" */
function fmtFY(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  // Yahoo uses calendar year for annual — Mar end FY convention: Apr–Mar
  const month = d.getMonth(); // 0-indexed
  const year  = d.getFullYear();
  const fy    = month >= 3 ? year + 1 : year; // Apr+ → next year
  return `FY${String(fy).slice(-2)}`;
}

/** Safe divide, returns null if denominator is 0 or null */
function pct(num, den) {
  if (!num || !den) return null;
  return Math.round((num / den) * 100);
}

/** CAGR over n years: ((end/start)^(1/n) - 1) * 100 */
function cagr(start, end, years) {
  if (!start || !end || years <= 0) return null;
  return Math.round((Math.pow(end / start, 1 / years) - 1) * 100);
}

// ─── Financials Singleton ─────────────────────────────────────────────────────

class Financials {
  constructor() {
    if (Financials.instance) return Financials.instance;
    this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    Financials.instance = this;
  }

  async analyze(symbol) {
    const ticker = `${symbol}.NS`;

    const now = new Date();
    const msPerYear = 365 * 24 * 60 * 60 * 1000;
    const date10yAgo = new Date(now - 10 * msPerYear);
    const date5yAgo  = new Date(now -  5 * msPerYear);

    const [
      quoteRes,
      summaryRes,
      annualPLRes,
      quarterlyPLRes,
      annualBSRes,
      quarterlyBSRes,
      annualCFRes,
      quarterlyCFRes,
      hist10yRes,
      hist5yRes,
    ] = await Promise.allSettled([
      this.yf.quote(ticker),
      this.yf.quoteSummary(ticker, {
        modules: ['defaultKeyStatistics', 'financialData', 'summaryProfile'],
      }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'financials', type: 'annual',    period1: new Date('2014-01-01') }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'financials', type: 'quarterly', period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000) }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'balance-sheet', type: 'annual',    period1: new Date('2014-01-01') }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'balance-sheet', type: 'quarterly', period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000) }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'cash-flow',     type: 'annual',    period1: new Date('2014-01-01') }),
      this.yf.fundamentalsTimeSeries(ticker, { module: 'cash-flow',     type: 'quarterly', period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000) }),
      this.yf.historical(ticker, { period1: date10yAgo, period2: now, interval: '1mo' }),
      this.yf.historical(ticker, { period1: date5yAgo,  period2: now, interval: '1mo' }),
    ]);

    const quote       = quoteRes.status       === 'fulfilled' ? quoteRes.value       : null;
    const summary     = summaryRes.status     === 'fulfilled' ? summaryRes.value     : {};
    const annualPL    = annualPLRes.status    === 'fulfilled' ? annualPLRes.value    : [];
    const quarterlyPL = quarterlyPLRes.status === 'fulfilled' ? quarterlyPLRes.value : [];
    const annualBS    = annualBSRes.status    === 'fulfilled' ? annualBSRes.value    : [];
    const annualCF    = annualCFRes.status    === 'fulfilled' ? annualCFRes.value    : [];
    const quarterlyCF = quarterlyCFRes.status === 'fulfilled' ? quarterlyCFRes.value : [];
    const quarterlyBS = quarterlyBSRes.status === 'fulfilled' ? quarterlyBSRes.value : [];
    const hist10y     = hist10yRes.status     === 'fulfilled' ? hist10yRes.value     : [];
    const hist5y      = hist5yRes.status      === 'fulfilled' ? hist5yRes.value      : [];

    const stats = summary.defaultKeyStatistics || {};
    const fin   = summary.financialData        || {};

    // Sort oldest → newest
    const sortAsc = (arr) => [...arr].sort((a, b) => new Date(a.date) - new Date(b.date));
    const annualPLSorted    = sortAsc(annualPL);
    const quarterlyPLSorted = sortAsc(quarterlyPL);
    const annualBSSorted    = sortAsc(annualBS);
    const quarterlyBSSorted = sortAsc(quarterlyBS);
    const annualCFSorted    = sortAsc(annualCF);
    const quarterlyCFSorted = sortAsc(quarterlyCF);

    return {
      symbol,
      exchange:  'NSE',
      currency:  'INR',
      unit:      'INR_CRORES',
      timestamp: new Date().toISOString(),

      raw: {
        annualPL:    annualPLSorted,
        quarterlyPL: quarterlyPLSorted,
        annualBS:    annualBSSorted,
        quarterlyBS: quarterlyBSSorted,
        annualCF:    annualCFSorted,
        quarterlyCF: quarterlyCFSorted,
      },

      standardized: {
        quarterly:  this._buildQuarterly(quarterlyPLSorted, quote, stats),
        annual:     this._buildAnnual(annualPLSorted, quote, stats),
        balanceSheet: this._buildBalanceSheet(annualBSSorted, quarterlyBSSorted),
        cashFlow:         this._buildCashFlow(annualCFSorted,    (r) => fmtFY(r.date)),
        cashFlowQuarterly: this._buildCashFlow(quarterlyCFSorted, (r) => fmtPeriod(r.date)),
        ttm:        this._buildTTM(fin, quote, stats),
        metrics:    this._buildMetrics(annualPLSorted, annualBSSorted, stats, fin, quote, hist10y, hist5y),
        valuation:  this._buildValuation(quote, stats, fin),
      },
    };
  }

  // ── Quarterly P&L ───────────────────────────────────────────────────────────

  _buildQuarterly(rows, quote, stats) {
    if (!rows.length) return { periods: [], rows: [] };

    const periods = rows.map((r) => fmtPeriod(r.date));
    const sharesOut = stats.sharesOutstanding ?? null;

    const pick = (field) => rows.map((r) => toCrores(r[field]));
    const pickRaw = (field) => rows.map((r) => r[field] ?? null);

    const revenues      = pick('totalRevenue');
    const expenses      = pick('totalExpenses') ?? pick('costOfRevenue');
    const opProfit      = rows.map((r, i) => {
      const rev = toCrores(r.totalRevenue);
      const exp = toCrores(r.operatingExpense ?? r.totalExpenses);
      const opInc = toCrores(r.operatingIncome);
      if (opInc != null) return opInc;
      if (rev != null && exp != null) return Math.round((rev - exp) * 100) / 100;
      return null;
    });

    const opm = rows.map((r, i) => {
      const rev = toCrores(r.totalRevenue);
      const op  = opProfit[i];
      return pct(op, rev);
    });

    const netProfit = pick('netIncome');
    const pbt       = pick('pretaxIncome');
    const interest  = pick('interestExpense');
    const deprec    = pick('depreciationAndAmortizationInCashFlow') ?? pick('reconciledDepreciation');

    const tax = rows.map((r, i) => {
      const pre = toCrores(r.pretaxIncome);
      const tax = toCrores(r.taxProvision);
      return pct(tax, pre);
    });

    const eps = rows.map((r) => {
      if (r.basicEPS != null) return r2(r.basicEPS);
      if (r.netIncome != null && sharesOut) return r2(r.netIncome / sharesOut);
      return null;
    });

    const otherIncome = rows.map((r) => toCrores(r.otherNonOperatingIncome ?? r.totalOtherFinancingActivities));

    return {
      periods,
      rows: [
        { key: 'revenue',         label: 'Sales',              values: revenues,   meta: { expandable: true } },
        { key: 'expenses',        label: 'Expenses',           values: expenses,   meta: { expandable: true } },
        { key: 'operatingProfit', label: 'Operating Profit',   values: opProfit,   highlight: true },
        { key: 'opm',             label: 'OPM %',              values: opm,        format: 'percent' },
        { key: 'otherIncome',     label: 'Other Income',       values: otherIncome },
        { key: 'interest',        label: 'Interest',           values: interest },
        { key: 'depreciation',    label: 'Depreciation',       values: deprec },
        { key: 'pbt',             label: 'Profit Before Tax',  values: pbt,        highlight: true },
        { key: 'tax',             label: 'Tax %',              values: tax,        format: 'percent' },
        { key: 'netProfit',       label: 'Net Profit',         values: netProfit,  highlight: true },
        { key: 'eps',             label: 'EPS',                values: eps },
      ],
    };
  }

  // ── Annual P&L ──────────────────────────────────────────────────────────────

  _buildAnnual(rows, quote, stats) {
    if (!rows.length) return { periods: [], rows: [] };

    const sharesOut = stats.sharesOutstanding ?? null;
    const periods   = rows.map((r) => fmtFY(r.date));

    // Append TTM as last period using quote data if available
    // (we just show annual rows; TTM is in ttm block)

    const pick = (field) => rows.map((r) => toCrores(r[field]));

    const revenues  = pick('totalRevenue');
    const expenses  = pick('totalExpenses');
    const opProfit  = rows.map((r) => {
      const opInc = toCrores(r.operatingIncome);
      if (opInc != null) return opInc;
      const rev = toCrores(r.totalRevenue);
      const exp = toCrores(r.operatingExpense ?? r.totalExpenses);
      if (rev != null && exp != null) return Math.round((rev - exp) * 100) / 100;
      return null;
    });
    const opm = rows.map((r, i) => pct(opProfit[i], revenues[i]));
    const pbt = pick('pretaxIncome');
    const netProfit = pick('netIncome');
    const eps = rows.map((r) => {
      if (r.basicEPS != null) return r2(r.basicEPS);
      if (r.netIncome != null && sharesOut) return r2(r.netIncome / sharesOut);
      return null;
    });

    return {
      periods,
      rows: [
        { key: 'revenue',         label: 'Sales',              values: revenues },
        { key: 'expenses',        label: 'Expenses',           values: expenses },
        { key: 'operatingProfit', label: 'Operating Profit',   values: opProfit, highlight: true },
        { key: 'opm',             label: 'OPM %',              values: opm,      format: 'percent' },
        { key: 'pbt',             label: 'Profit Before Tax',  values: pbt },
        { key: 'netProfit',       label: 'Net Profit',         values: netProfit, highlight: true },
        { key: 'eps',             label: 'EPS',                values: eps },
      ],
    };
  }

  // ── Balance Sheet ───────────────────────────────────────────────────────────

  _buildBalanceSheet(annualRows, quarterlyRows) {
    const buildRows = (rows, labelFn) => {
      if (!rows.length) return { periods: [], rows: [] };
      const periods = rows.map(labelFn);
      const pick = (field) => rows.map((r) => toCrores(r[field]));
      return {
        periods,
        rows: [
          { key: 'equityCapital',    label: 'Equity Capital',    values: pick('commonStock') },
          { key: 'reserves',         label: 'Reserves',          values: pick('retainedEarnings') },
          { key: 'borrowings',       label: 'Borrowings',        values: pick('totalDebt') },
          { key: 'otherLiabilities', label: 'Other Liabilities', values: pick('otherCurrentLiabilities') },
          { key: 'totalLiabilities', label: 'Total Liabilities', values: pick('totalLiabilitiesNetMinorityInterest'), highlight: true },
          { key: 'fixedAssets',      label: 'Fixed Assets',      values: pick('netPPE') },
          { key: 'cwip',             label: 'CWIP',              values: pick('constructionInProgress') },
          { key: 'investments',      label: 'Investments',       values: pick('longTermEquityInvestment') },
          { key: 'otherAssets',      label: 'Other Assets',      values: pick('otherAssets') },
          { key: 'totalAssets',      label: 'Total Assets',      values: pick('totalAssets'), highlight: true },
        ],
      };
    };

    return {
      annual:    buildRows(annualRows,    (r) => fmtFY(r.date)),
      quarterly: buildRows(quarterlyRows, (r) => fmtPeriod(r.date)),
    };
  }

  // ── Cash Flow ───────────────────────────────────────────────────────────────

  _buildCashFlow(rows, labelFn = (r) => fmtFY(r.date)) {
    if (!rows.length) return { periods: [], rows: [] };
    const periods = rows.map(labelFn);
    const pick = (field) => rows.map((r) => toCrores(r[field]));
    return {
      periods,
      rows: [
        { key: 'operatingCF',  label: 'Cash from Operations', values: pick('operatingCashFlow'),  highlight: true },
        { key: 'investingCF',  label: 'Cash from Investing',  values: pick('investingCashFlow') },
        { key: 'financingCF',  label: 'Cash from Financing',  values: pick('financingCashFlow') },
        { key: 'freeCashFlow', label: 'Free Cash Flow',       values: pick('freeCashFlow') },
        { key: 'capex',        label: 'Capex',                values: pick('capitalExpenditure') },
      ],
    };
  }

  // ── TTM ─────────────────────────────────────────────────────────────────────

  _buildTTM(fin, quote, stats) {
    return {
      revenue:   toCrores(fin.totalRevenue)  ?? null,
      ebitda:    toCrores(fin.ebitda)        ?? null,
      netProfit: toCrores(fin.netIncomeToCommon ?? null) ?? null,
      eps:       r2(quote?.epsTrailingTwelveMonths) ?? null,
    };
  }

  // ── Growth Metrics ──────────────────────────────────────────────────────────

  _buildMetrics(annualRows, annualBS, stats, fin, quote, hist10y, hist5y) {
    const sorted = annualRows;
    const n = sorted.length;

    const revSeries    = sorted.map((r) => toCrores(r.totalRevenue));
    const profitSeries = sorted.map((r) => toCrores(r.netIncome));

    const salesGrowth3y  = n >= 4  ? cagr(revSeries[n - 4],  revSeries[n - 1],  3) : null;
    const salesGrowth5y  = n >= 6  ? cagr(revSeries[n - 6],  revSeries[n - 1],  5) : null;
    const salesGrowth10y = n >= 11 ? cagr(revSeries[n - 11], revSeries[n - 1], 10) : null;
    const salesGrowthTTM = fin.revenueGrowth != null ? Math.round(fin.revenueGrowth * 100) : null;

    const profitGrowth3y  = n >= 4  ? cagr(profitSeries[n - 4],  profitSeries[n - 1],  3) : null;
    const profitGrowth10y = n >= 11 ? cagr(profitSeries[n - 11], profitSeries[n - 1], 10) : null;
    const profitGrowthTTM = fin.earningsGrowth != null ? Math.round(fin.earningsGrowth * 100) : null;

    // ROE = netIncome / stockholdersEquity per year
    const bsSorted = [...annualBS].sort((a, b) => new Date(a.date) - new Date(b.date));
    const roeSeries = sorted.map((plRow) => {
      const plYear = new Date(plRow.date).getFullYear();
      const bsRow  = bsSorted.find((b) => new Date(b.date).getFullYear() === plYear);
      if (!bsRow || !plRow.netIncome || !bsRow.stockholdersEquity) return null;
      return (plRow.netIncome / bsRow.stockholdersEquity) * 100;
    });
    const avgRoe = (series, count) => {
      const slice = series.slice(-count).filter((v) => v != null);
      if (!slice.length) return null;
      return Math.round(slice.reduce((s, v) => s + v, 0) / slice.length);
    };
    const roeLastYear = fin.returnOnEquity != null ? Math.round(fin.returnOnEquity * 100) : null;
    const roe3y  = roeSeries.length >= 3  ? avgRoe(roeSeries, 3)  : null;
    const roe5y  = roeSeries.length >= 5  ? avgRoe(roeSeries, 5)  : null;
    const roe10y = roeSeries.length >= 10 ? avgRoe(roeSeries, 10) : null;

    // Stock price CAGR from historical monthly closes
    const firstClose = (hist) => hist && hist.length ? hist[0].close : null;
    const lastClose  = (hist) => hist && hist.length ? hist[hist.length - 1].close : null;
    const week52Chg  = stats['52WeekChange'] != null ? Math.round(stats['52WeekChange'] * 100) : null;
    const stockCagr5y  = cagr(firstClose(hist5y),  lastClose(hist5y),  5);
    const stockCagr10y = cagr(firstClose(hist10y), lastClose(hist10y), 10);

    return {
      salesGrowth: {
        '3y':  salesGrowth3y,
        '5y':  salesGrowth5y,
        '10y': salesGrowth10y,
        ttm:   salesGrowthTTM,
      },
      profitGrowth: {
        '3y':  profitGrowth3y,
        '10y': profitGrowth10y,
        ttm:   profitGrowthTTM,
      },
      roe: {
        '3y':  roe3y,
        '5y':  roe5y,
        '10y': roe10y,
        last:  roeLastYear,
      },
      stockPriceCagr: {
        '1y':  week52Chg,
        '3y':  null,
        '5y':  stockCagr5y,
        '10y': stockCagr10y,
      },
    };
  }

  // ── Valuation ───────────────────────────────────────────────────────────────

  _buildValuation(quote, stats, fin) {
    return {
      marketCap:       toCrores(quote?.marketCap)               ?? null,
      enterpriseValue: toCrores(stats.enterpriseValue)          ?? null,
      peRatio:         r2(quote?.trailingPE)                    ?? null,
      forwardPE:       r2(quote?.forwardPE)                     ?? null,
      pbRatio:         r2(stats.priceToBook)                    ?? null,
      evToEbitda:      r2(stats.enterpriseToEbitda)             ?? null,
      evToRevenue:     r2(stats.enterpriseToRevenue)            ?? null,
      dividendYield:   r2(quote?.dividendYield)                 ?? null,
      bookValue:       r2(stats.bookValue)                      ?? null,
      eps:             r2(quote?.epsTrailingTwelveMonths)       ?? null,
    };
  }
}

const financials = new Financials();
module.exports = financials;
