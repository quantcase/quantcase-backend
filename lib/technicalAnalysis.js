'use strict';

const https   = require('https');
const { parse } = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;

const indicators = require('../utils/taIndicators');
const scoring    = require('../utils/taScoring');

// ─── Constants ────────────────────────────────────────────────────────────────

const SHEET_ID      = '1sIGiqjZ4-neKafJsYCRFo_y0Y2vb_h0-';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const ONE_YEAR_MS   = 365 * 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantCase/1.0)' } };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── TechnicalAnalysis Singleton ──────────────────────────────────────────────

/**
 * TechnicalAnalysis singleton.
 * Orchestrates Yahoo Finance data fetching, delegates indicator computation
 * to utils/taIndicators.js, scoring to utils/taScoring.js, and assembles
 * the full technicals response payload.
 *
 * Usage:
 *   const technicalAnalysis = require('./lib/technicalAnalysis');
 *   const result = await technicalAnalysis.analyze('MSUMI');
 */
class TechnicalAnalysis {
  constructor() {
    if (TechnicalAnalysis.instance) {
      return TechnicalAnalysis.instance;
    }
    this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    TechnicalAnalysis.instance = this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Main entry point: compute full technicals for a symbol.
   * @param {string} symbol  e.g. 'MSUMI' (no .NS suffix)
   * @returns {Promise<object>}  full technicals payload
   * @throws {Error}  with statusCode 404 if symbol not in watchlist
   */
  async analyze(symbol) {
    const ticker = `${symbol}.NS`;

    const [marketData, watchlistRow] = await Promise.all([
      this.fetchMarketData(ticker),
      this.fetchWatchlistRow(symbol),
    ]);

    if (!watchlistRow) {
      const err = new Error(`Symbol ${symbol} not found in watchlist`);
      err.statusCode = 404;
      throw err;
    }

    // Compute all indicators across three timeframes
    const rawIndicators = indicators.computeAll(
      marketData.dailyBars,
      marketData.weeklyBars,
      marketData.monthlyBars,
      marketData.quote
    );

    const d = rawIndicators.daily;

    // Score each pillar
    const trendScore      = scoring.scoreTrend(d);
    const momentumScore   = scoring.scoreMomentum(d);
    const volumeScore     = scoring.scoreVolume(d);
    const volatilityScore = scoring.scoreVolatility(d);

    const finalSignal = scoring.computeFinalSignal({
      trendScore, momentumScore, volumeScore, volatilityScore,
    });

    const timeframes = scoring.computeTimeframes(
      rawIndicators.daily,
      rawIndicators.weekly,
      rawIndicators.monthly
    );

    const insights = scoring.generateInsights(d);

    return this._buildResponse(
      symbol,
      rawIndicators,
      finalSignal,
      timeframes,
      insights,
      watchlistRow,
      marketData.nextEarningsDate
    );
  }

  // ── Data Fetching ──────────────────────────────────────────────────────────

  /**
   * Fetch all Yahoo Finance data in parallel via Promise.allSettled.
   * Resilient: returns empty arrays/nulls for any failed call.
   *
   * @param {string} ticker  e.g. 'MSUMI.NS'
   * @returns {Promise<{ dailyBars, weeklyBars, monthlyBars, quote, nextEarningsDate }>}
   */
  async fetchMarketData(ticker) {
    const now = Date.now();
    const [daily, weekly, monthly, quoteResult, calendarResult] = await Promise.allSettled([
      this.yf.chart(ticker, { period1: new Date(now - ONE_YEAR_MS), interval: '1d' }),
      this.yf.chart(ticker, { period1: new Date(now - 2 * ONE_YEAR_MS), interval: '1wk' }),
      this.yf.chart(ticker, { period1: new Date(now - 3 * ONE_YEAR_MS), interval: '1mo' }),
      this.yf.quote(ticker),
      this.yf.quoteSummary(ticker, { modules: ['calendarEvents'] }),
    ]);

    const dailyBars   = this._normaliseBars(daily.status   === 'fulfilled' ? daily.value?.quotes   : []);
    const weeklyBars  = this._normaliseBars(weekly.status  === 'fulfilled' ? weekly.value?.quotes  : []);
    const monthlyBars = this._normaliseBars(monthly.status === 'fulfilled' ? monthly.value?.quotes : []);
    const quote       = quoteResult.status === 'fulfilled' ? quoteResult.value : null;

    const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : {};
    const earningsDates = calendar.calendarEvents?.earnings?.earningsDate ?? [];
    const nextEarningsDate = earningsDates.length > 0
      ? earningsDates[0].toISOString().slice(0, 10)
      : null;

    return { dailyBars, weeklyBars, monthlyBars, quote, nextEarningsDate };
  }

  /**
   * Fetch Google Sheet CSV and return the row matching `symbol`.
   * @param {string} symbol  e.g. 'MSUMI'
   * @returns {Promise<object|null>}
   */
  async fetchWatchlistRow(symbol) {
    try {
      const csv = await fetchUrl(SHEET_CSV_URL);
      const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
      return rows.find((r) => (r['Stock'] || '').toUpperCase() === symbol) ?? null;
    } catch {
      return null;
    }
  }

  // ── Internal Helpers ───────────────────────────────────────────────────────

  /**
   * Normalise Yahoo Finance chart quotes to a consistent bar shape.
   * Filters out bars with null or NaN closes.
   * @param {Array} quotes
   * @returns {Array<{date:string, open:number, high:number, low:number, close:number, volume:number}>}
   */
  _normaliseBars(quotes) {
    if (!quotes || quotes.length === 0) return [];
    return quotes
      .filter((q) => q.close != null && !isNaN(q.close))
      .map((q) => ({
        date:   q.date instanceof Date ? q.date.toISOString().slice(0, 10) : String(q.date).slice(0, 10),
        open:   q.open   ?? q.close,
        high:   q.high   ?? q.close,
        low:    q.low    ?? q.close,
        close:  q.close,
        volume: q.volume ?? 0,
      }));
  }

  /**
   * Assemble the full technicals response payload from computed parts.
   */
  _buildResponse(symbol, raw, finalSignal, timeframes, insights, row, nextEarningsDate) {
    const d = raw.daily;
    if (!d || Object.keys(d).length === 0) {
      return { symbol, error: 'Insufficient price data to compute technicals' };
    }

    const sheetSupport    = parseFloat(row['SUPPORT'])    || null;
    const sheetResistance = parseFloat(row['RESISTANCE']) || null;

    const dynSR = scoring.dynamicSupportResistance(d.cmp, {
      sma20: d.sma20, sma50: d.sma50, sma100: d.sma100, sma200: d.sma200,
    });

    const fibLevels = (sheetSupport && sheetResistance)
      ? indicators.fibonacciLevels(sheetSupport, sheetResistance)
      : indicators.fibonacciLevels(d.low52w, d.high52w);

    const pivots = indicators.pivotPoints(d.high, d.low, d.prevClose);

    const trendDir      = scoring.trendDirection(d);
    const trendStr      = scoring.trendStrength(d.adx14);
    const phase         = (row['PHASE'] || '').toUpperCase() || scoring.marketPhase(d);

    const sheetPattern = row['PATTERN'] || null;
    const patterns = sheetPattern
      ? [{
          name:           sheetPattern,
          type:           'UNKNOWN',
          confidence:     null,
          timeframe:      'DAILY',
          breakoutLevel:  sheetResistance,
          breakdownLevel: sheetSupport,
        }]
      : [];

    return {
      symbol,
      exchange:  'NSE',
      timestamp: new Date().toISOString(),

      // Watchlist metadata
      meta: {
        macroSector:     row['MACRO ECO SECTOR'] || null,
        basicIndustry:   row['BASIC INDUSTRY']   || null,
        pe:              row['PE']               || null,
        sheetTrend:      row['TREND']            || null,
        srRange:         row['%S/R RANGE']       || null,
        nextEarningsDate,
      },

      price: {
        cmp:          r2(d.cmp),
        change:       r2(d.cmp - d.prevClose),
        changePercent: r2(((d.cmp - d.prevClose) / d.prevClose) * 100),
        open:         r2(d.open),
        high:         r2(d.high),
        low:          r2(d.low),
        prevClose:    r2(d.prevClose),
        volume:       d.volume,
        avgVolume20d: d.avgVolume20 ? Math.round(d.avgVolume20) : null,
        volumeRatio:  r2(d.volumeRatio),
        high52w:      r2(d.high52w),
        low52w:       r2(d.low52w),
        distanceFrom52wHigh: r2(d.distFrom52wHigh),
        distanceFrom52wLow:  r2(d.distFrom52wLow),
      },

      trend: {
        direction: trendDir,
        strength:  trendStr,
        adx14:     r2(d.adx14),
        structure: {
          higherHighs: d.higherHighs,
          higherLows:  d.higherLows,
        },
        phase,
      },

      movingAverages: {
        sma: {
          20:  r2(d.sma20),
          50:  r2(d.sma50),
          100: r2(d.sma100),
          200: r2(d.sma200),
        },
        ema: {
          20: r2(d.ema20),
          50: r2(d.ema50),
        },
        pricePosition: {
          aboveSMA20:  d.aboveSMA20,
          aboveSMA50:  d.aboveSMA50,
          aboveSMA200: d.aboveSMA200,
        },
        crossovers: {
          goldenCross:       d.goldenCross,
          deathCross:        d.deathCross,
          lastCrossoverDate: d.lastCrossoverDate,
        },
      },

      momentum: {
        rsi: {
          value: r2(d.rsi14),
          zone:  d.rsiZone,
          trend: d.rsiTrend,
        },
        macd: d.macdValue != null ? {
          value:     r2(d.macdValue),
          signal:    r2(d.macdSignal),
          histogram: r2(d.macdHistogram),
          crossover: d.macdCrossover,
        } : null,
        stochastic: d.stochK != null ? {
          k:      r2(d.stochK),
          d:      r2(d.stochD),
          signal: d.stochSignal,
        } : null,
      },

      volume: {
        current:  d.volume,
        avg20:    d.avgVolume20 ? Math.round(d.avgVolume20) : null,
        ratio:    r2(d.volumeRatio),
        trend:    d.volumeTrend,
        signals: {
          volumeBreakout: d.volumeBreakout,
          accumulation:   d.accumulation,
          distribution:   d.distribution,
        },
      },

      volatility: {
        atr14:      r2(d.atr14),
        atrPercent: r2(d.atrPercent),
        bollingerBands: d.bbUpper != null ? {
          upper:   r2(d.bbUpper),
          middle:  r2(d.bbMiddle),
          lower:   r2(d.bbLower),
          width:   r2(d.bbWidth),
          squeeze: d.bbSqueeze,
        } : null,
      },

      supportResistance: {
        static: {
          support:    sheetSupport    ? [sheetSupport]    : [],
          resistance: sheetResistance ? [sheetResistance] : [],
        },
        pivotPoints: pivots,
        dynamic:     dynSR,
        fibonacci:   fibLevels,
      },

      patterns,

      signals: {
        overall:          finalSignal.overall,
        score:            finalSignal.score,
        timeframeSignals: timeframes.timeframeSignals,
        components:       finalSignal.components,
      },

      timeframes: {
        daily:               timeframes.daily,
        weekly:              timeframes.weekly,
        monthly:             timeframes.monthly,
        multiTimeframeScore:  timeframes.multiTimeframeScore,
        multiTimeframeSignal: timeframes.multiTimeframeSignal,
      },

      insights,
    };
  }
}

// Export singleton instance
const technicalAnalysis = new TechnicalAnalysis();
module.exports = technicalAnalysis;
