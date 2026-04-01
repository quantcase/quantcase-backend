'use strict';

const YahooFinance = require('yahoo-finance2').default;
const technicalAnalysis = require('../lib/technicalAnalysis');
const financials = require('../lib/financials');
const { generateDecisionIntelligence } = require('../utils/decisionIntelligence');
const prisma = require('../config/prisma');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

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

    // Fetch in parallel: quote, summary modules, quarterly fundamentals, annual cash flow
    const [quoteResult, summaryResult, quarterlyResult, cashFlowResult] = await Promise.allSettled([
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
        period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000), // last 2 years
      }),
    ]);

    const q = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    if (!q) return res.status(404).json({ error: `Ticker ${ticker} not found` });

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    const profile  = summary.summaryProfile      || {};
    const fin      = summary.financialData       || {};
    const stats    = summary.defaultKeyStatistics || {};

    // Get most recent annual cash flow entry
    const cashFlowRaw = cashFlowResult.status === 'fulfilled' ? cashFlowResult.value : [];
    const latestCashFlow = cashFlowRaw.length > 0
      ? [...cashFlowRaw].sort((a, b) => new Date(b.date) - new Date(a.date))[0]
      : null;

    // Quarterly trend for revenue/EBITDA chart — sorted oldest→newest
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
        changePercent:  q.regularMarketChangePercent  ?? null,
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
        // TTM figures from financialData (plain numbers in v3, no .raw needed)
        revenue:          fin.totalRevenue      ?? null,
        revenueGrowth:    fin.revenueGrowth     ?? null,
        grossProfits:     fin.grossProfits      ?? null,
        grossMargins:     fin.grossMargins      ?? null,
        ebitda:           fin.ebitda            ?? null,
        ebitdaMargins:    fin.ebitdaMargins     ?? null,
        operatingMargins: fin.operatingMargins  ?? null,
        profitMargins:    fin.profitMargins     ?? null,
        operatingCashflow: latestCashFlow?.operatingCashFlow ?? fin.operatingCashflow ?? null,
        freeCashflow:     latestCashFlow?.freeCashFlow     ?? fin.freeCashflow      ?? null,
        earningsGrowth:   fin.earningsGrowth    ?? null,
        revenuePerShare:  fin.revenuePerShare   ?? null,
        // Quarterly chart data
        quarterlyTrend,
      },

      valuation: {
        peRatio:         q.trailingPE                       ?? null,
        forwardPE:       q.forwardPE                        ?? null,
        pbRatio:         stats.priceToBook                  ?? null,
        evToEbitda:      stats.enterpriseToEbitda           ?? null,
        evToRevenue:     stats.enterpriseToRevenue          ?? null,
        enterpriseValue: stats.enterpriseValue              ?? null,
        profitMargins:   stats.profitMargins                ?? null,
      },

      efficiency: {
        returnOnEquity:  fin.returnOnEquity  ?? null,
        returnOnAssets:  fin.returnOnAssets  ?? null,
        debtToEquity:    fin.debtToEquity    ?? null,
        currentRatio:    fin.currentRatio    ?? null,
        quickRatio:      fin.quickRatio      ?? null,
        totalCash:       fin.totalCash       ?? null,
        totalDebt:       fin.totalDebt       ?? null,
        totalCashPerShare: fin.totalCashPerShare ?? null,
      },

      perShare: {
        eps:           q.epsTrailingTwelveMonths ?? null,
        epsForward:    q.epsForward              ?? null,
        bookValue:     stats.bookValue           ?? null,
        dividendRate:  q.dividendRate            ?? null,
        dividendYield: q.dividendYield           ?? null,
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

    res.json({ symbol, ticker, count: prices.length, prices });
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

module.exports = { getTickerInfo, getTechnicals, getFinancials, getPrices, getCharts };
