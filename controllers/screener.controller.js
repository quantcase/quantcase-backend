'use strict';

const YahooFinance = require('yahoo-finance2').default;
const technicalAnalysis = require('../lib/technicalAnalysis');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function getTechnicals(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await technicalAnalysis.analyze(symbol);
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

    // Fetch in parallel: quote, summary modules, quarterly fundamentals
    const [quoteResult, summaryResult, quarterlyResult] = await Promise.allSettled([
      yahooFinance.quote(ticker),
      yahooFinance.quoteSummary(ticker, {
        modules: ['summaryProfile', 'financialData', 'defaultKeyStatistics'],
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'financials',
        type: 'quarterly',
        period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000), // last 2 years
      }),
    ]);

    const q = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    if (!q) return res.status(404).json({ error: `Ticker ${ticker} not found` });

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    const profile  = summary.summaryProfile      || {};
    const fin      = summary.financialData       || {};
    const stats    = summary.defaultKeyStatistics || {};

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
        operatingCashflow: fin.operatingCashflow ?? null,
        freeCashflow:     fin.freeCashflow      ?? null,
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

module.exports = { getTickerInfo, getTechnicals };
