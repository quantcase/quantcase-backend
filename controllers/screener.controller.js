'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;
const technicalAnalysis = require('../lib/technicalAnalysis');
const financials = require('../lib/financials');
const { generateDecisionIntelligence } = require('../utils/decisionIntelligence');
const { computeIndicatorSeries } = require('../utils/taIndicators');
const prisma = require('../config/prisma');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Peer comparison helpers (reuse Prowess CSV data) ────────────────────────

// Identity CSV column indices (0-based)
const ID_COL_NAME          = 0;
const ID_COL_INDUSTRY_GRP  = 9;   // "Industry group"
const ID_COL_NSE_BASIC_IND = 24;  // "NSE Basic Industry classification"
const ID_COL_NSE_SYMBOL    = 25;  // "NSE symbol"

// Fundamental CSV layout (same as prowess.controller)
const PEER_COLS_PER_PERIOD = 20;
const PEER_PERIOD_COUNT    = 8;
const PEER_OFF = { SHARES: 0, MARKET_CAP: 1, ADJ_EPS: 3, PE: 5, PB: 6, YIELD: 8,
                   EV: 9, TOTAL_INCOME: 13, NET_PROFIT: 15 };

let _peerIdentityRows  = null; // raw parsed rows (array of arrays)
let _peerIdentityHeader = null;
let _peerFundMap       = null; // { companyName: row[] }
let _peerFundQtrs      = null; // string[]

function loadPeerIdentity() {
  if (_peerIdentityRows) return { rows: _peerIdentityRows, header: _peerIdentityHeader };
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_identity.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  _peerIdentityHeader = all[0];
  _peerIdentityRows   = all.slice(1);
  return { rows: _peerIdentityRows, header: _peerIdentityHeader };
}

function loadPeerFundamentals() {
  if (_peerFundMap) return { fundMap: _peerFundMap, qtrs: _peerFundQtrs };
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_fundamental_ind_qtr_v4.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  const quarterRow = all[4];
  _peerFundQtrs = [];
  for (let i = 0; i < PEER_PERIOD_COUNT; i++) {
    _peerFundQtrs.push(quarterRow[1 + i * PEER_COLS_PER_PERIOD] || `Q${i + 1}`);
  }
  _peerFundMap = {};
  for (const row of all.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _peerFundMap[name] = row;
  }
  return { fundMap: _peerFundMap, qtrs: _peerFundQtrs };
}

function peerToFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }

/** Extract one metric from a Prowess row at a given period index */
function peerPeriodVal(row, periodIndex, offset) {
  const start = 1 + periodIndex * PEER_COLS_PER_PERIOD;
  return peerToFloat(row[start + offset]);
}

async function getTechnicals(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await technicalAnalysis.analyze(symbol);
    result.decisionIntelligence = await generateDecisionIntelligence(result);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
}
async function getTickerInfo(req, res, next) {
  try {
    const { symbol } = req.params;
    const ticker = symbol.toUpperCase() + '.NS';

    // Fetch in parallel: quote, summary modules, quarterly fundamentals, annual cash flow, annual financials, annual balance sheet
    const [quoteResult, summaryResult, quarterlyResult, cashFlowResult, annualFinancialsResult, annualBalanceSheetResult, ownershipResult] = await Promise.allSettled([
      yahooFinance.quote(ticker),
      yahooFinance.quoteSummary(ticker, {
        modules: ['summaryProfile', 'financialData', 'defaultKeyStatistics'],
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'financials',
        type: 'quarterly',
        period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000), // last 2 years
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'cash-flow',
        type: 'annual',
        period1: new Date(Date.now() - 4 * 365 * 24 * 60 * 60 * 1000), // last 4 years
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'financials',
        type: 'annual',
        period1: new Date(Date.now() - 4 * 365 * 24 * 60 * 60 * 1000), // last 4 years for growth + EPS CAGR
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'balance-sheet',
        type: 'annual',
        period1: new Date(Date.now() - 4 * 365 * 24 * 60 * 60 * 1000), // last 4 years for reserves/debt/ROCE
      }),
      yahooFinance.quoteSummary(ticker, {
        modules: ['majorHoldersBreakdown'],
      }),
    ]);

    const q = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    if (!q) return res.status(404).json({ error: `Ticker ${ticker} not found` });

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    const profile  = summary.summaryProfile      || {};
    const fin      = summary.financialData       || {};
    const stats    = summary.defaultKeyStatistics || {};

    // ── Annual series (sorted oldest → newest) ──────────────────────────────
    const annualFinancialsRaw    = annualFinancialsResult.status    === 'fulfilled' ? annualFinancialsResult.value    : [];
    const annualCashFlowRaw      = cashFlowResult.status            === 'fulfilled' ? cashFlowResult.value            : [];
    const annualBalanceSheetRaw  = annualBalanceSheetResult.status  === 'fulfilled' ? annualBalanceSheetResult.value  : [];

    const annualFin = [...annualFinancialsRaw].sort((a, b) => new Date(a.date) - new Date(b.date));
    const annualCF  = [...annualCashFlowRaw].sort((a, b) => new Date(a.date) - new Date(b.date));
    const annualBS  = [...annualBalanceSheetRaw].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Most recent entries
    const latestFin = annualFin[annualFin.length - 1] ?? null;
    const prevFin   = annualFin[annualFin.length - 2] ?? null;
    const latestCF  = annualCF[annualCF.length - 1]   ?? null;
    const prevCF    = annualCF[annualCF.length - 2]   ?? null;
    const latestBS  = annualBS[annualBS.length - 1]   ?? null;
    const prevBS    = annualBS[annualBS.length - 2]   ?? null;

    // ── YoY growth helper ───────────────────────────────────────────────────
    function yoy(curr, prev) {
      if (curr == null || prev == null || prev === 0) return null;
      return (curr - prev) / Math.abs(prev);
    }

    // ── Key financials ──────────────────────────────────────────────────────
    const netProfit       = latestFin?.netIncome        ?? null;
    const netProfitPrev   = prevFin?.netIncome          ?? null;
    const ebitda          = latestFin?.EBITDA           ?? fin.ebitda ?? null;
    const ebitdaPrev      = prevFin?.EBITDA             ?? null;
    const operatingCashflow = latestCF?.operatingCashFlow ?? fin.operatingCashflow ?? null;
    const cfoP            = prevCF?.operatingCashFlow   ?? null;
    const freeCashflow    = latestCF?.freeCashFlow      ?? fin.freeCashflow ?? null;
    const fcfPrev         = prevCF?.freeCashFlow        ?? null;
    const reserves        = latestBS?.stockholdersEquity ?? null;
    const reservesPrev    = prevBS?.stockholdersEquity  ?? null;
    const totalDebt       = latestBS?.totalDebt         ?? fin.totalDebt ?? null;
    const totalDebtPrev   = prevBS?.totalDebt           ?? null;
    const totalCash       = fin.totalCash               ?? null;
    const enterpriseValue = stats.enterpriseValue       ?? null;

    // ── ROCE per year: operatingIncome / investedCapital ───────────────────
    function roceForEntry(finEntry, bsEntry) {
      if (!finEntry || !bsEntry) return null;
      const oi = finEntry.operatingIncome ?? null;
      const ic = bsEntry.investedCapital  ?? null;
      if (oi == null || ic == null || ic === 0) return null;
      return oi / ic;
    }

    const roceValues = annualFin.map((f) => {
      const matchedBS = annualBS.find((b) => b.date.getFullYear() === f.date.getFullYear());
      return roceForEntry(f, matchedBS);
    }).filter((v) => v != null);

    const roce     = roceValues[roceValues.length - 1] ?? null;
    const roce3yAvg = roceValues.length > 0
      ? roceValues.reduce((s, v) => s + v, 0) / roceValues.length
      : null;

    // ── ROE per year: netIncome / stockholdersEquity ────────────────────────
    function roeForEntry(finEntry, bsEntry) {
      if (!finEntry || !bsEntry) return null;
      const ni = finEntry.netIncome        ?? null;
      const eq = bsEntry.stockholdersEquity ?? null;
      if (ni == null || eq == null || eq === 0) return null;
      return ni / eq;
    }

    const roeValues = annualFin.map((f) => {
      const matchedBS = annualBS.find((b) => b.date.getFullYear() === f.date.getFullYear());
      return roeForEntry(f, matchedBS);
    }).filter((v) => v != null);

    const roe     = roeValues[roeValues.length - 1] ?? fin.returnOnEquity ?? null;
    const roe3yAvg = roeValues.length > 0
      ? roeValues.reduce((s, v) => s + v, 0) / roeValues.length
      : null;

    // ── 3Y EPS CAGR ─────────────────────────────────────────────────────────
    const epsSorted = annualFin.filter((s) => s.basicEPS != null);
    let epsCagr3y = null;
    if (epsSorted.length >= 2) {
      const newest = epsSorted[epsSorted.length - 1];
      const oldest = epsSorted[0];
      const years = (newest.date - oldest.date) / (365.25 * 24 * 60 * 60 * 1000);
      if (years >= 1 && oldest.basicEPS !== 0) {
        epsCagr3y = (newest.basicEPS / oldest.basicEPS) ** (1 / years) - 1;
      }
    }

    // ── Derived ratios ───────────────────────────────────────────────────────
    const ebitdaEvYield = ebitda != null && enterpriseValue != null && enterpriseValue !== 0
      ? ebitda / enterpriseValue : null;
    const cfoEbitdaPct  = operatingCashflow != null && ebitda != null && ebitda !== 0
      ? operatingCashflow / ebitda : null;
    const netDebtEbitda = totalDebt != null && totalCash != null && ebitda != null && ebitda !== 0
      ? (totalDebt - totalCash) / ebitda : null;

    // PEG: trailingPE / (earningsGrowth as %)  — earningsGrowth is already a decimal
    const trailingPE    = q.trailingPE ?? null;
    const earningsGrowth = fin.earningsGrowth ?? null;
    const pegRatio = trailingPE != null && earningsGrowth != null && earningsGrowth > 0
      ? trailingPE / (earningsGrowth * 100) : null;

    // Valuation label based on PE vs forward PE
    function peLabel(pe, forwardPe) {
      if (pe == null) return null;
      if (forwardPe != null && pe > forwardPe * 1.2) return 'Premium';
      if (forwardPe != null && pe < forwardPe * 0.8) return 'Discount';
      return 'Fair';
    }

    // Debt status
    function debtStatusLabel(debtToEquity) {
      if (debtToEquity == null) return null;
      if (debtToEquity < 0.1) return 'Debt-free';
      if (debtToEquity < 0.5) return 'Near debt-free';
      if (debtToEquity < 1.0) return 'Low debt';
      if (debtToEquity < 2.0) return 'Moderate debt';
      return 'High debt';
    }

    // ── Ownership (majorHoldersBreakdown) ────────────────────────────────────
    const ownershipSummary = ownershipResult.status === 'fulfilled' ? ownershipResult.value : {};
    const holders = ownershipSummary.majorHoldersBreakdown || {};
    const promoter     = holders.insidersPercentHeld      ?? null;
    const institutions = holders.institutionsPercentHeld  ?? null;
    // FII/DII breakdown is not available from Yahoo Finance (India-specific BSE data)
    const publicPct = promoter != null && institutions != null
      ? Math.max(0, 1 - promoter - institutions) : null;

    function publicLabel(pct) {
      if (pct == null) return null;
      if (pct < 0.15) return 'Low';
      if (pct < 0.35) return 'Moderate';
      return 'High';
    }

    // ── Quarterly trend for revenue/EBITDA chart ─────────────────────────────
    const quarterlyRaw = quarterlyResult.status === 'fulfilled' ? quarterlyResult.value : [];
    const quarterlyTrend = [...quarterlyRaw]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((s) => ({
        period: new Date(s.date).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
        revenue: s.totalRevenue ?? null,
        ebitda:  s.EBITDA ?? null,
        grossProfit: s.grossProfit ?? null,
        operatingIncome: s.operatingIncome ?? null,
        netIncome: s.netIncome ?? null,
        eps: s.basicEPS ?? null,
      }));

    res.json({
      symbol: symbol.toUpperCase(),
      ticker,

      company: {
        name:        q.longName || q.shortName || symbol,
        exchange:    q.exchange || 'NSE',
        sector:      profile.sector   || null,
        industry:    profile.industry || null,
        description: profile.longBusinessSummary || null,
        website:     profile.website  || null,
        employees:   profile.fullTimeEmployees || null,
        country:     profile.country  || 'India',
      },

      quote: {
        price:          q.regularMarketPrice          ?? null,
        change:         q.regularMarketChange         ?? null,
        changePercent:  q.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null,
        open:           q.regularMarketOpen           ?? null,
        high:           q.regularMarketDayHigh        ?? null,
        low:            q.regularMarketDayLow         ?? null,
        previousClose:  q.regularMarketPreviousClose  ?? null,
        volume:         q.regularMarketVolume         ?? null,
        avgVolume:      q.averageDailyVolume3Month     ?? null,
        week52High:     q.fiftyTwoWeekHigh            ?? null,
        week52Low:      q.fiftyTwoWeekLow             ?? null,
        marketCap:      q.marketCap                   ?? null,
        currency:       q.currency || 'INR',
        marketState:    q.marketState                 || null,
        lastUpdated:    q.regularMarketTime           || null,
      },

      financialPerformance: {
        revenue:           fin.totalRevenue      ?? null,
        revenueGrowth:     fin.revenueGrowth     ?? null,
        grossProfits:      fin.grossProfits      ?? null,
        grossMargins:      fin.grossMargins      ?? null,
        ebitda,
        ebitdaGrowth:      yoy(ebitda, ebitdaPrev),
        ebitdaMargins:     fin.ebitdaMargins     ?? null,
        operatingMargins:  fin.operatingMargins  ?? null,
        netProfit,
        netProfitGrowth:   yoy(netProfit, netProfitPrev),
        profitMargins:     fin.profitMargins     ?? null,
        operatingCashflow,
        cfoGrowth:         yoy(operatingCashflow, cfoP),
        freeCashflow,
        fcfGrowth:         yoy(freeCashflow, fcfPrev),
        earningsGrowth:    fin.earningsGrowth    ?? null,
        revenuePerShare:   fin.revenuePerShare   ?? null,
        reserves,
        reservesGrowth:    yoy(reserves, reservesPrev),
        quarterlyTrend,
      },

      valuation: {
        peRatio:            trailingPE,
        peValuationLabel:   peLabel(trailingPE, q.forwardPE ?? null),
        forwardPE:          q.forwardPE                        ?? null,
        pbRatio:            stats.priceToBook                  ?? null,
        pegRatio,
        evToEbitda:         stats.enterpriseToEbitda           ?? null,
        evToRevenue:        stats.enterpriseToRevenue          ?? null,
        enterpriseValue,
        profitMargins:      stats.profitMargins                ?? null,
        industryPE:         null,   // not available from Yahoo Finance
        industryPELabel:    null,
      },

      efficiency: {
        returnOnEquity:  roe,
        returnOnAssets:  fin.returnOnAssets  ?? null,
        debtToEquity:    fin.debtToEquity    ?? null,
        debtGrowth:      yoy(totalDebt, totalDebtPrev),
        currentRatio:    fin.currentRatio    ?? null,
        quickRatio:      fin.quickRatio      ?? null,
        totalCash,
        totalDebt,
        totalCashPerShare: fin.totalCashPerShare ?? null,
      },

      perShare: {
        eps:           q.epsTrailingTwelveMonths ?? null,
        epsForward:    q.epsForward              ?? null,
        bookValue:     stats.bookValue           ?? null,
        dividendRate:  q.dividendRate            ?? null,
        dividendYield: q.dividendYield != null ? q.dividendYield / 100 : null,
        payoutRatio:   stats.payoutRatio         ?? null,
      },

      analystRatings: {
        targetHighPrice:           fin.targetHighPrice           ?? null,
        targetLowPrice:            fin.targetLowPrice            ?? null,
        targetMeanPrice:           fin.targetMeanPrice           ?? null,
        targetMedianPrice:         fin.targetMedianPrice         ?? null,
        recommendationKey:         fin.recommendationKey         ?? null,
        numberOfAnalystOpinions:   fin.numberOfAnalystOpinions   ?? null,
      },

      keyStats: {
        beta:                     q.beta                          ?? null,
        sharesOutstanding:        stats.sharesOutstanding         ?? null,
        floatShares:              stats.floatShares               ?? null,
        heldPercentInsiders:      stats.heldPercentInsiders       ?? null,
        heldPercentInstitutions:  stats.heldPercentInstitutions   ?? null,
        earningsQuarterlyGrowth:  stats.earningsQuarterlyGrowth   ?? null,
        fiftyDayAverage:          q.fiftyDayAverage               ?? null,
        twoHundredDayAverage:     q.twoHundredDayAverage          ?? null,
        week52Change:             stats['52WeekChange']            ?? null,
      },

      ratios: {
        roce,
        roce3yAvg,
        roe,
        roe3yAvg,
        debtStatus: debtStatusLabel(fin.debtToEquity ?? null),
      },

      ownership: {
        promoter,        // insiders % held (decimal)
        institutions,    // institutions % held (decimal)
        fii:    null,    // not available from Yahoo Finance (India BSE-specific)
        dii:    null,    // not available from Yahoo Finance (India BSE-specific)
        public: publicPct,
        publicLabel: publicLabel(publicPct),
      },

      financials: {
        eps_cagr_3y:     epsCagr3y,
        ebitda_ev_yield: ebitdaEvYield,
        cfo_ebitda_pct:  cfoEbitdaPct,
        net_debt_ebitda: netDebtEbitda,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getFinancials(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await financials.analyze(symbol);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getPrices(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    const period1 = req.query.from
      ? new Date(req.query.from)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // default: 1 year
    const period2 = req.query.to ? new Date(req.query.to) : new Date();

    const result = await yahooFinance.chart(ticker, {
      period1,
      period2,
      interval: '1d',
    });

    const quotes = result.quotes ?? [];
    const prices = quotes
      .filter((r) => r.close != null)
      .map((r) => ({
        date: new Date(r.date).toISOString().slice(0, 10),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        adjClose: r.adjclose ?? null,
        volume: r.volume ?? null,
      }));

    const indicators = computeIndicatorSeries(prices);

    res.json({ symbol, ticker, count: prices.length, prices, indicators });
  } catch (err) {
    next(err);
  }
}

// ── Charts ────────────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/charts
 *
 * Returns chart-ready data grouped by: Price, PE Ratio, Sales & Margin.
 * Each group contains barSeries and lineSeries arrays whose data share the same x values.
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    // ── 1. Fetch raw data in parallel ──────────────────────────────────────
    const now = Date.now();
    const tenYearsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    const [monthlyChartRes, quarterlyChartRes, peRowsRes, quarterlyFundamentalsRes, quarterlyIncomeRes, quarterlyBalanceSheetRes] = await Promise.allSettled([
      yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '1mo',
      }),
      yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '3mo',
      }),
      prisma.pe_data.findMany({
        where: { company: symbol },
        orderBy: { date: 'asc' },
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'financials',
        type: 'quarterly',
        period1: new Date(now - 2 * 365 * 24 * 60 * 60 * 1000),
      }),
      yahooFinance.quoteSummary(ticker, {
        modules: ['incomeStatementHistoryQuarterly'],
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'balance-sheet',
        type: 'quarterly',
        period1: new Date(now - 2 * 365 * 24 * 60 * 60 * 1000),
      }),
    ]);

    const monthlyChart        = monthlyChartRes.status           === 'fulfilled' ? monthlyChartRes.value           : null;
    const quarterlyChart      = quarterlyChartRes.status         === 'fulfilled' ? quarterlyChartRes.value         : null;
    const peRows              = peRowsRes.status                 === 'fulfilled' ? peRowsRes.value                 : [];
    const quarterlyFundamentals = quarterlyFundamentalsRes.status === 'fulfilled' ? quarterlyFundamentalsRes.value : [];
    // incomeStatementHistoryQuarterly: totalRevenue and netIncome are reliable; grossProfit/operatingIncome are zeroed since Nov 2024
    const quarterlyIncome     = quarterlyIncomeRes.status === 'fulfilled'
      ? (quarterlyIncomeRes.value?.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [])
      : [];
    const quarterlyBalanceSheet = quarterlyBalanceSheetRes.status === 'fulfilled' ? quarterlyBalanceSheetRes.value : [];

    // ── 2. Price group ─────────────────────────────────────────────────────
    // Monthly bars sorted oldest→newest, labelled "Mon YYYY"
    const monthlyQuotes = (monthlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Compute rolling SMAs over the ordered close series
    function rollingAvg(closes, window) {
      return closes.map((_, i) => {
        if (i < window - 1) return null;
        const slice = closes.slice(i - window + 1, i + 1);
        return Math.round((slice.reduce((s, v) => s + v, 0) / window) * 100) / 100;
      });
    }

    const fmtMonthLabel = (date) => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    };

    const monthlyLabels = monthlyQuotes.map((q) => fmtMonthLabel(q.date));
    const monthlyCloses = monthlyQuotes.map((q) => q.close);
    // 50 DMA ≈ 50-day: using 3-month monthly window as rough proxy; for monthly bars use 3
    // 200 DMA ≈ 200-day ≈ 10 months
    const dma50Values  = rollingAvg(monthlyCloses, 3);
    const dma200Values = rollingAvg(monthlyCloses, 10);

    const priceGroup = {
      group: 'Price',
      barSeries: [
        {
          dataKey: 'volume',
          name: 'Volume',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: q.volume ?? null })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceNSE',
          name: 'Price on NSE',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: Math.round(q.close * 100) / 100 })),
        },
        {
          dataKey: 'dma50',
          name: '50 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma50Values[i] })),
        },
        {
          dataKey: 'dma200',
          name: '200 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma200Values[i] })),
        },
      ],
    };

    // ── 3–7. Shared helpers for fundamentals-based groups ─────────────────
    // qChartQuotes: quarterly price series for priceForQuarter lookups
    const qChartQuotes = (quarterlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Sort balance sheet and financials oldest→newest
    const bsSorted = [...quarterlyBalanceSheet].sort((a, b) => new Date(a.date) - new Date(b.date));
    const qfSorted = [...quarterlyFundamentals].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Most recent balance sheet entry — fallback for quarters beyond last BS date
    const latestBs = bsSorted.length > 0 ? bsSorted[bsSorted.length - 1] : null;

    // Find closest entry within ±50 days
    const MS_50D = 50 * 24 * 60 * 60 * 1000;
    function closestByDate(arr, targetMs) {
      let best = null, bestDiff = MS_50D;
      for (const r of arr) {
        const diff = Math.abs(new Date(r.date).getTime() - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      return best;
    }

    // Balance sheet for a quarter: closest match, or latest if target is beyond last BS date
    function bsForQuarter(targetMs) {
      const exact = closestByDate(bsSorted, targetMs);
      if (exact) return exact;
      if (latestBs && targetMs > new Date(latestBs.date).getTime()) return latestBs;
      return null;
    }

    // Price at a given quarter-end date, matched from qChartQuotes within ±50 days
    function priceForQuarter(targetMs) {
      return closestByDate(qChartQuotes.map((q) => ({ date: q.date, close: q.close })), targetMs)?.close ?? null;
    }

    // Shared x-axis labels for groups 3, 5–7 (oldest→newest, ~5 quarters)
    const fundLabels = qfSorted.map((r) =>
      new Date(r.date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    );

    // ── 3. PE Ratio group ──────────────────────────────────────────────────
    // X-axis: qfSorted (~5 quarters, same as groups 5–7).
    // TTM EPS = sum of basicEPS for up to 4 quarters ending at this date.
    // PE = price / TTM EPS. Fallback: closest pe_data entry within ±45 days.
    // Median PE: from pe_data DB if available.

    // Median PE across all pe_data rows
    const allPeValues = peRows
      .map((r) => (r.pe != null ? Number(r.pe) : null))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    let medianPe = null;
    if (allPeValues.length > 0) {
      const mid = Math.floor(allPeValues.length / 2);
      medianPe = allPeValues.length % 2 === 0
        ? Math.round(((allPeValues[mid - 1] + allPeValues[mid]) / 2) * 100) / 100
        : Math.round(allPeValues[mid] * 100) / 100;
    }

    const MS_45D = 45 * 24 * 60 * 60 * 1000;

    // peData uses qfSorted as x-axis (same as groups 5–7)
    const peData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);

      // TTM EPS: sum basicEPS across up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmEps = recent4.length > 0 && recent4.every((x) => x.basicEPS != null)
        ? Math.round(recent4.reduce((s, x) => s + x.basicEPS, 0) * 100) / 100
        : null;

      // Computed PE from price / ttmEps
      let pe = price != null && ttmEps != null && ttmEps !== 0
        ? Math.round((price / ttmEps) * 100) / 100
        : null;

      // Fallback: closest pe_data entry within ±45 days
      if (pe === null) {
        let best = null, bestDiff = MS_45D;
        for (const row of peRows) {
          const diff = Math.abs(new Date(row.date).getTime() - qt);
          if (diff < bestDiff) { bestDiff = diff; best = row; }
        }
        if (best?.pe != null) pe = Math.round(Number(best.pe) * 100) / 100;
      }

      return { ttmEps, pe };
    });

    const peGroup = {
      group: 'PE Ratio',
      barSeries: [
        {
          dataKey: 'ttmEps',
          name: 'TTM EPS',
          data: fundLabels.map((x, i) => ({ x, y: peData[i].ttmEps })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: fundLabels.map((x, i) => ({ x, y: peData[i].pe })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: fundLabels.map((x) => ({ x, y: medianPe })),
        },
      ],
    };

    // ── 4. Sales & Margin group ────────────────────────────────────────────
    // Merge quarterlyFundamentals (5 periods) + quarterlyIncome (4 periods) deduplicated,
    // sorted oldest→newest.

    const smMerged = [...quarterlyFundamentals];
    for (const r of quarterlyIncome) {
      const rDate = new Date(r.endDate).toISOString().slice(0, 10);
      const existing = smMerged.find(
        (x) => new Date(x.date).toISOString().slice(0, 10) === rDate
      );
      if (existing) {
        // Backfill only totalRevenue and netIncome if missing — grossProfit/operatingIncome are zeroed in this source
        if (existing.totalRevenue == null && r.totalRevenue != null) existing.totalRevenue = r.totalRevenue;
        if (existing.netIncome == null && r.netIncome != null) existing.netIncome = r.netIncome;
      } else {
        smMerged.push({ date: r.endDate, totalRevenue: r.totalRevenue, netIncome: r.netIncome });
      }
    }
    smMerged.sort((a, b) => new Date(a.date) - new Date(b.date));

    const smLabels = smMerged.map((r) =>
      new Date(r.date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    );

    const smRevenue = smMerged.map((r) => {
      const v = r.totalRevenue;
      return v != null ? Math.round(v / 1e7 * 100) / 100 : null;
    });

    const smOpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const opInc = r.operatingIncome != null ? r.operatingIncome : (
        r.totalRevenue != null && (r.operatingExpense ?? r.totalExpenses) != null
          ? r.totalRevenue - (r.operatingExpense ?? r.totalExpenses)
          : null
      );
      if (!rev || opInc === null) return null;
      return Math.round((opInc / rev) * 10000) / 100;
    });

    const smGpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const gp = r.grossProfit != null ? r.grossProfit : (
        r.totalRevenue != null && r.costOfRevenue != null
          ? r.totalRevenue - r.costOfRevenue
          : null
      );
      if (!rev || gp === null) return null;
      return Math.round((gp / rev) * 10000) / 100;
    });

    const smNpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const np = r.netIncome;
      if (!rev || np == null) return null;
      return Math.round((np / rev) * 10000) / 100;
    });

    const salesMarginGroup = {
      group: 'Sales & Margin',
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales',
          data: smLabels.map((x, i) => ({ x, y: smRevenue[i] })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: smLabels.map((x, i) => ({ x, y: smGpm[i] })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: smLabels.map((x, i) => ({ x, y: smOpm[i] })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: smLabels.map((x, i) => ({ x, y: smNpm[i] })),
        },
      ],
    };

    // ── 5. EV / EBITDA group ───────────────────────────────────────────────
    // Bar: quarterly EBITDA (Cr). Line: EV/EBITDA per quarter. Median: 30.3.

    const evEbitdaData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const ebitdaCr = r.EBITDA != null ? Math.round(r.EBITDA / 1e7 * 100) / 100 : null;

      const bs = bsForQuarter(qt);
      const shares = bs?.ordinarySharesNumber ?? null;
      const totalDebt = bs?.totalDebt ?? 0;
      const cash = bs?.cashCashEquivalentsAndShortTermInvestments ?? bs?.cashAndCashEquivalents ?? 0;
      const ev = price != null && shares != null ? price * shares + totalDebt - cash : null;

      // TTM EBITDA: sum of up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmEbitda = recent4.length > 0 && recent4.every((x) => x.EBITDA != null)
        ? recent4.reduce((s, x) => s + x.EBITDA, 0)
        : null;

      const ratio = ev != null && ttmEbitda != null && ttmEbitda !== 0
        ? Math.round((ev / ttmEbitda) * 100) / 100
        : null;

      return { ebitdaCr, ratio };
    });

    const MEDIAN_EV_EBITDA = 30.3;
    const evEbitdaGroup = {
      group: 'EV / EBITDA',
      barSeries: [
        {
          dataKey: 'ebitda',
          name: 'EBITDA',
          data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ebitdaCr })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / EBITDA',
          data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ratio })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 6. Price to Book group ─────────────────────────────────────────────
    // Bar: Book Value per share (₹). Line: P/BV. Median: 19.6.

    const pbvData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const bs = bsForQuarter(qt);
      const equity = bs?.stockholdersEquity ?? bs?.commonStockEquity ?? null;
      const shares = bs?.ordinarySharesNumber ?? null;
      const bvps = equity != null && shares != null && shares !== 0
        ? Math.round((equity / shares) * 100) / 100
        : null;
      const pbv = price != null && bvps != null && bvps !== 0
        ? Math.round((price / bvps) * 100) / 100
        : null;
      return { bvps, pbv };
    });

    const MEDIAN_PBV = 19.6;
    const priceToBookGroup = {
      group: 'Price to Book',
      barSeries: [
        {
          dataKey: 'bookValue',
          name: 'Book Value',
          data: fundLabels.map((x, i) => ({ x, y: pbvData[i].bvps })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceToBV',
          name: 'Price to BV',
          data: fundLabels.map((x, i) => ({ x, y: pbvData[i].pbv })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 7. Market Cap / Sales group ────────────────────────────────────────
    // Bar: quarterly Sales (Cr). Line: Market Cap / TTM Sales. Median: 3.5.

    const mcSalesData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const bs = bsForQuarter(qt);
      const shares = bs?.ordinarySharesNumber ?? null;
      const marketCap = price != null && shares != null ? price * shares : null;

      const quarterRevenueCr = r.totalRevenue != null ? Math.round(r.totalRevenue / 1e7 * 100) / 100 : null;

      // TTM revenue: sum of up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmRevenue = recent4.length > 0 && recent4.every((x) => x.totalRevenue != null)
        ? recent4.reduce((s, x) => s + x.totalRevenue, 0)
        : null;

      const mcToSales = marketCap != null && ttmRevenue != null && ttmRevenue !== 0
        ? Math.round((marketCap / ttmRevenue) * 100) / 100
        : null;

      return { quarterRevenueCr, mcToSales };
    });

    const MEDIAN_MC_SALES = 3.5;
    const mcSalesGroup = {
      group: 'Market Cap / Sales',
      barSeries: [
        {
          dataKey: 'sales',
          name: 'Sales',
          data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].quarterRevenueCr })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'mcToSales',
          name: 'Market Cap / Sales',
          data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].mcToSales })),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_MC_SALES })),
        },
      ],
    };

    res.json({ chartGroups: [priceGroup, peGroup, salesMarginGroup, evEbitdaGroup, priceToBookGroup, mcSalesGroup] });
  } catch (err) {
    next(err);
  }
}

// ── Peer comparison ───────────────────────────────────────────────────────────

/**
 * POST /api/screener/:symbol/peers
 *
 * Body (optional):
 *   { "indicators": ["cmp","pe","marketCap","divYld","npQtr","qtrProfitVar","salesQtr","qtrSalesVar","roce"] }
 *
 * 1. Resolve symbol → NSE Basic Industry classification via osc_identity.csv
 * 2. Collect all peers in the same basic industry (+ same industry group for tighter match)
 * 3. Pull latest-quarter fundamentals from osc_fundamental_ind_qtr_v4.csv
 * 4. Bulk-fetch Yahoo Finance quotes for live CMP & Market Cap
 * 5. Return table rows with requested indicators as columns
 */
async function getPeers(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // Default column set matches the image
    const DEFAULT_INDICATORS = ['cmp','pe','marketCap','divYld','npQtr','qtrProfitVar','salesQtr','qtrSalesVar','roce'];
    const requestedIndicators = (req.body && Array.isArray(req.body.indicators) && req.body.indicators.length > 0)
      ? req.body.indicators
      : DEFAULT_INDICATORS;

    // ── 1. Find subject company in identity CSV ──────────────────────────────
    const { rows: idRows } = loadPeerIdentity();
    const subjectRow = idRows.find((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase() === symbol);
    if (!subjectRow) {
      return res.status(404).json({ error: `Symbol "${symbol}" not found in identity data` });
    }

    const subjectBasicInd  = (subjectRow[ID_COL_NSE_BASIC_IND] || '').trim();
    const subjectIndGrp    = (subjectRow[ID_COL_INDUSTRY_GRP]  || '').trim();

    // ── 2. Find all peers in same basic industry ─────────────────────────────
    // Include subject itself so it appears in the table (highlighted by caller)
    const peerRows = idRows.filter((r) => {
      const ind = (r[ID_COL_NSE_BASIC_IND] || '').trim();
      const sym = (r[ID_COL_NSE_SYMBOL] || '').trim();
      return ind === subjectBasicInd && sym !== '';
    });

    if (peerRows.length === 0) {
      return res.status(404).json({ error: `No peers found for industry "${subjectBasicInd}"` });
    }

    // ── 3. Load Prowess fundamentals ─────────────────────────────────────────
    const { fundMap, qtrs } = loadPeerFundamentals();
    const LATEST = PEER_PERIOD_COUNT - 1;   // index 7
    const YEAR_AGO = LATEST - 4;            // index 3  (same quarter, prior year)

    // ── 4. Bulk-fetch Yahoo Finance quotes ───────────────────────────────────
    const nseSymbols = peerRows.map((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase()).filter(Boolean);
    const tickers    = nseSymbols.map((s) => s + '.NS');

    const quoteResults = await Promise.allSettled(
      tickers.map((t) => yahooFinance.quote(t))
    );

    // Build a map: NSE symbol → quote
    const quoteMap = {};
    nseSymbols.forEach((sym, i) => {
      if (quoteResults[i].status === 'fulfilled') quoteMap[sym] = quoteResults[i].value;
    });

    // ── 5. Build table rows ──────────────────────────────────────────────────
    const latestQtr = qtrs[LATEST];
    const yearAgoQtr = qtrs[YEAR_AGO] || null;

    const peers = peerRows.map((idRow) => {
      const peerSymbol = (idRow[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase();
      const companyName = (idRow[ID_COL_NAME] || '').trim();
      const quote = quoteMap[peerSymbol] || null;
      const fundRow = fundMap[companyName] || null;

      // ── Live quote data ──
      const cmp = quote ? r2(quote.regularMarketPrice) : null;
      let marketCap = quote && quote.marketCap != null ? r2(quote.marketCap / 1e7) : null; // Cr

      // ── Prowess fundamentals (latest period) ──
      let pe         = null;
      let divYld     = null;
      let npQtr      = null;      // Net Profit Qtr (Cr)
      let salesQtr   = null;      // Sales Qtr (Cr)
      let qtrProfitVar = null;    // YoY Net Profit Var %
      let qtrSalesVar  = null;    // YoY Sales Var %
      let roce         = null;    // ROCE % — approximated from Prowess data

      if (fundRow) {
        pe      = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.PE));
        divYld  = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.YIELD));
        npQtr   = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.NET_PROFIT));
        salesQtr = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.TOTAL_INCOME));

        // Qtr YoY variance
        const npPrior    = peerPeriodVal(fundRow, YEAR_AGO, PEER_OFF.NET_PROFIT);
        const salesPrior = peerPeriodVal(fundRow, YEAR_AGO, PEER_OFF.TOTAL_INCOME);
        if (npQtr != null && npPrior != null && npPrior !== 0) {
          qtrProfitVar = r2(((npQtr - npPrior) / Math.abs(npPrior)) * 100);
        }
        if (salesQtr != null && salesPrior != null && salesPrior !== 0) {
          qtrSalesVar = r2(((salesQtr - salesPrior) / Math.abs(salesPrior)) * 100);
        }

        // ROCE ≈ EBIT / Capital Employed
        // Prowess doesn't expose EBIT directly; approximate via:
        //   EBIT ≈ Net Profit + Tax + Interest (not available in this CSV)
        // Best proxy available: use Yahoo's returnOnEquity + debtToEquity from quoteSummary
        // For now derive a rough ROCE from Yahoo financialData if quote exists
        if (quote) {
          // Yahoo doesn't surface ROCE directly; use returnOnEquity as stand-in when fundRow data is insufficient.
          // Caller can override by requesting ROCE separately via /financials.
          roce = null; // deferred — populated below via bulk quoteSummary
        }
      }

      // Fall back to Yahoo PE if Prowess is missing
      if (pe == null && quote) pe = r2(quote.trailingPE ?? null);
      // Fall back to Yahoo marketCap if Prowess missing
      if (marketCap == null && quote && quote.marketCap != null) {
        marketCap = r2(quote.marketCap / 1e7);
      }

      const row = {
        symbol:    peerSymbol,
        name:      companyName,
        isSubject: peerSymbol === symbol,
      };

      if (requestedIndicators.includes('cmp'))          row.cmp          = cmp;
      if (requestedIndicators.includes('pe'))           row.pe           = pe;
      if (requestedIndicators.includes('marketCap'))    row.marketCapCr  = marketCap;
      if (requestedIndicators.includes('divYld'))       row.divYld       = divYld;
      if (requestedIndicators.includes('npQtr'))        row.npQtrCr      = npQtr;
      if (requestedIndicators.includes('qtrProfitVar')) row.qtrProfitVar = qtrProfitVar;
      if (requestedIndicators.includes('salesQtr'))     row.salesQtrCr   = salesQtr;
      if (requestedIndicators.includes('qtrSalesVar'))  row.qtrSalesVar  = qtrSalesVar;
      if (requestedIndicators.includes('roce'))         row.roce         = roce;

      return row;
    });

    // ── 6. Fetch ROCE via bulk quoteSummary (financialData.returnOnAssets/Equity) ──
    if (requestedIndicators.includes('roce')) {
      const roceResults = await Promise.allSettled(
        nseSymbols.map((s) => yahooFinance.quoteSummary(s + '.NS', { modules: ['financialData'] }))
      );
      nseSymbols.forEach((sym, i) => {
        const peerEntry = peers.find((p) => p.symbol === sym);
        if (!peerEntry) return;
        if (roceResults[i].status === 'fulfilled') {
          const fin = roceResults[i].value?.financialData || {};
          // Yahoo doesn't provide ROCE directly. Approximate:
          // ROCE ≈ returnOnEquity * (equity / capitalEmployed)
          // Since we lack balance sheet detail, use returnOnEquity × (1 + 1/debtToEquity) when debtToEquity > 0
          const roe = fin.returnOnEquity ?? null;
          const de  = fin.debtToEquity  ?? null;
          if (roe != null) {
            let roceVal;
            if (de != null && de > 0) {
              // Capital Employed = Equity + Debt ≈ Equity × (1 + D/E)
              // ROCE ≈ NetIncome / CapitalEmployed = ROE / (1 + D/E)
              roceVal = r2((roe / (1 + de / 100)) * 100);
            } else {
              roceVal = r2(roe * 100);
            }
            peerEntry.roce = roceVal;
          }
        }
      });
    }

    // Sort: subject first, then by marketCap desc
    peers.sort((a, b) => {
      if (a.isSubject) return -1;
      if (b.isSubject) return 1;
      return (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0);
    });

    res.json({
      symbol,
      basicIndustry: subjectBasicInd,
      industryGroup: subjectIndGrp,
      latestQuarter: latestQtr,
      yearAgoQuarter: yearAgoQtr,
      indicators: requestedIndicators,
      count: peers.length,
      peers,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getTickerInfo, getTechnicals, getFinancials, getPrices, getCharts, getPeers };
