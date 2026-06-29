'use strict';

const { parse } = require('csv-parse/sync');
const https     = require('https');

const indicators  = require('../utils/taIndicators');
const { resolveTechnicalIndicators } = require('../utils/formulaRegistry/index');
const { aggregateBars, aggregateIndexBars, fetchOhlcvBars, fetchIndexBars } = require('../utils/formulaRegistry/dataFetcherMarket');
const scoring     = require('../utils/taScoring');
const { computeRuleEngine, SECTOR_TICKER_MAP } = require('../utils/taRuleEngine');
const prisma      = require('../config/prisma');

// ─── Constants ────────────────────────────────────────────────────────────────

const SHEET_ID        = '1sIGiqjZ4-neKafJsYCRFo_y0Y2vb_h0-';
const SHEET_CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const ONE_YEAR_MS     = 365 * 24 * 60 * 60 * 1000;
const SHEET_TTL_MS    = 15 * 60 * 1000; // 15 minutes

// ─── Watchlist sheet cache ────────────────────────────────────────────────────
let _sheetRows   = null;
let _sheetExpiry = 0;

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

// aggregateBars and aggregateIndexBars live in dataFetcherMarket.js — imported above.

// ─── TechnicalAnalysis Singleton ──────────────────────────────────────────────

class TechnicalAnalysis {
  constructor() {
    if (TechnicalAnalysis.instance) return TechnicalAnalysis.instance;
    TechnicalAnalysis.instance = this;
  }

  async analyze(symbol) {
    const [marketData, watchlistRow] = await Promise.all([
      this.fetchMarketData(symbol),
      this.fetchWatchlistRow(symbol),
    ]);

    if (!watchlistRow) {
      const err = new Error(`Symbol ${symbol} not found in watchlist`);
      err.statusCode = 404;
      throw err;
    }

    const rawIndicators = resolveTechnicalIndicators(
      marketData.dailyBars,
      marketData.weeklyBars,
      marketData.monthlyBars,
      marketData.quote
    );

    const d = rawIndicators.daily;

    const crsDataPromise = this._fetchCRSData(
      watchlistRow['MACRO ECO SECTOR'] || '',
      marketData.dailyBars
    ).catch(() => ({ vsNifty: null, vsSector: null }));

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

    const crsData          = await crsDataPromise;
    const ruleEngineResult = computeRuleEngine(d, watchlistRow, crsData);

    return this._buildResponse(
      symbol,
      rawIndicators,
      finalSignal,
      timeframes,
      insights,
      watchlistRow,
      marketData.nextEarningsDate,
      ruleEngineResult,
      marketData.allTimeHigh,
      marketData.allTimeLow,
      marketData.allTimeHighDate,
      marketData.allTimeLowDate,
      marketData.high52wDate,
      marketData.low52wDate
    );
  }

  // ── Data Fetching ──────────────────────────────────────────────────────────

  async fetchMarketData(symbol) {
    return fetchOhlcvBars(prisma, symbol);
  }

  async fetchWatchlistRow(symbol) {
    try {
      if (!_sheetRows || Date.now() > _sheetExpiry) {
        const csv  = await fetchUrl(SHEET_CSV_URL);
        _sheetRows   = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
        _sheetExpiry = Date.now() + SHEET_TTL_MS;
      }
      return _sheetRows.find((r) => (r['Stock'] || '').toUpperCase() === symbol) ?? null;
    } catch {
      return null;
    }
  }

  // ── CRS ────────────────────────────────────────────────────────────────────

  _computeCRS(stockBars, indexBars, period = 12, emaPeriod = 7) {
    if (!stockBars || !indexBars || stockBars.length < period + emaPeriod || indexBars.length < period + emaPeriod) {
      return null;
    }

    const stockMap = new Map(stockBars.map((b) => [b.date, b.close]));
    const indexMap = new Map(indexBars.map((b) => [b.date, b.close]));

    const commonDates = stockBars.map((b) => b.date).filter((d) => indexMap.has(d));
    if (commonDates.length < period + emaPeriod) return null;

    const crsRaw = [];
    for (let i = period; i < commonDates.length; i++) {
      const d    = commonDates[i];
      const dN   = commonDates[i - period];
      const sNow = stockMap.get(d);
      const sOld = stockMap.get(dN);
      const iNow = indexMap.get(d);
      const iOld = indexMap.get(dN);
      if (!sNow || !sOld || !iNow || !iOld || sOld === 0 || iOld === 0 || iNow === 0) continue;
      crsRaw.push((sNow / sOld) / (iNow / iOld) * 100);
    }

    if (crsRaw.length < emaPeriod + 1) return null;

    const crsValueCurr = indicators.ema(crsRaw, emaPeriod);
    const crsValuePrev = indicators.ema(crsRaw.slice(0, -1), emaPeriod);

    return {
      crsValue:     crsValueCurr != null ? Math.round(crsValueCurr * 100) / 100 : null,
      prevCrsValue: crsValuePrev  != null ? Math.round(crsValuePrev * 100) / 100 : null,
    };
  }

  async _fetchCRSData(macroSector, dailyBars) {
    const sectorKey = (macroSector || '').toUpperCase().trim();
    // SECTOR_TICKER_MAP values are Yahoo tickers like "^CNXIT"; map to nse_index sector names
    const SECTOR_NAME_MAP = {
      'IT':     'NIFTY IT',
      'BANKS':  'NIFTY BANK',
      'FMCG':   'NIFTY FMCG',
      'PHARMA': 'NIFTY PHARMA',
      'AUTO':   'NIFTY AUTO',
      'INFRA':  'NIFTY INFRA',
      'METAL':  'NIFTY METAL',
      'ENERGY': 'NIFTY ENERGY',
      'REALTY': 'NIFTY REALTY',
      'MEDIA':  'NIFTY MEDIA',
    };
    const sectorName    = SECTOR_NAME_MAP[sectorKey] ?? null;
    const oneYearAgo    = new Date(Date.now() - ONE_YEAR_MS);

    const since = oneYearAgo;
    const [niftyData, sectorData] = await Promise.all([
      fetchIndexBars(prisma, 'NIFTY 50', { since }),
      sectorName ? fetchIndexBars(prisma, sectorName, { since }) : Promise.resolve(null),
    ]);

    const niftyBars  = niftyData?.daily  ?? [];
    const sectorBars = sectorData?.daily ?? [];

    const vsNifty  = niftyBars.length  > 0 ? this._computeCRS(dailyBars, niftyBars)  : null;
    const vsSector = sectorBars.length > 0
      ? { ...this._computeCRS(dailyBars, sectorBars), sectorTicker: sectorName }
      : null;

    return { vsNifty, vsSector };
  }

  // ── Response builder (unchanged shape) ────────────────────────────────────

  _buildResponse(symbol, raw, finalSignal, timeframes, insights, row, nextEarningsDate, ruleEngineResult, allTimeHigh, allTimeLow, allTimeHighDate, allTimeLowDate, high52wDate, low52wDate) {
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

    const trendDir   = scoring.trendDirection(d);
    const trendStr   = scoring.trendStrength(d.adx14);
    const phase      = (row['PHASE'] || '').toUpperCase() || scoring.marketPhase(d);

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
        high52wDate:  high52wDate  ?? null,
        low52w:       r2(d.low52w),
        low52wDate:   low52wDate   ?? null,
        distanceFrom52wHigh: r2(d.distFrom52wHigh),
        distanceFrom52wLow:  r2(d.distFrom52wLow),
        allTimeHigh:      r2(allTimeHigh),
        allTimeHighDate:  allTimeHighDate ?? null,
        allTimeLow:       r2(allTimeLow),
        allTimeLowDate:   allTimeLowDate  ?? null,
        distanceFromATH:  allTimeHigh > 0 ? r2(((d.cmp - allTimeHigh) / allTimeHigh) * 100) : null,
        distanceFromATL:  allTimeLow  > 0 ? r2(((d.cmp - allTimeLow)  / allTimeLow)  * 100) : null,
      },

      trend: {
        direction: trendDir,
        strength:  trendStr,
        adx14:     r2(d.adx14),
        structure: { higherHighs: d.higherHighs, higherLows: d.higherLows },
        phase,
      },

      movingAverages: {
        sma: { 20: r2(d.sma20), 50: r2(d.sma50), 100: r2(d.sma100), 200: r2(d.sma200) },
        sma50Prev10: r2(d.sma50Prev10),
        ema: { 20: r2(d.ema20), 50: r2(d.ema50) },
        pricePosition: { aboveSMA20: d.aboveSMA20, aboveSMA50: d.aboveSMA50, aboveSMA200: d.aboveSMA200 },
        crossovers: { goldenCross: d.goldenCross, deathCross: d.deathCross, lastCrossoverDate: d.lastCrossoverDate },
      },

      momentum: {
        rsi: { value: r2(d.rsi14), zone: d.rsiZone, trend: d.rsiTrend },
        macd: d.macdValue != null ? {
          value: r2(d.macdValue), signal: r2(d.macdSignal), histogram: r2(d.macdHistogram), crossover: d.macdCrossover,
        } : null,
        stochastic: d.stochK != null ? { k: r2(d.stochK), d: r2(d.stochD), signal: d.stochSignal } : null,
      },

      volume: {
        current: d.volume,
        avg20:   d.avgVolume20 ? Math.round(d.avgVolume20) : null,
        ratio:   r2(d.volumeRatio),
        trend:   d.volumeTrend,
        signals: { volumeBreakout: d.volumeBreakout, accumulation: d.accumulation, distribution: d.distribution },
      },

      volatility: {
        atr14:      r2(d.atr14),
        atrPercent: r2(d.atrPercent),
        bollingerBands: d.bbUpper != null ? {
          upper: r2(d.bbUpper), middle: r2(d.bbMiddle), lower: r2(d.bbLower), width: r2(d.bbWidth), squeeze: d.bbSqueeze,
        } : null,
      },

      supportResistance: {
        static:      { support: sheetSupport ? [sheetSupport] : [], resistance: sheetResistance ? [sheetResistance] : [] },
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
      ruleEngine: ruleEngineResult ?? null,
    };
  }
}

const technicalAnalysis = new TechnicalAnalysis();
module.exports = technicalAnalysis;
