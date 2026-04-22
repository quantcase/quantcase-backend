'use strict';

const { parse } = require('csv-parse/sync');
const https     = require('https');

const indicators  = require('../utils/taIndicators');
const scoring     = require('../utils/taScoring');
const { computeRuleEngine, SECTOR_TICKER_MAP } = require('../utils/taRuleEngine');
const prisma      = require('../config/prisma');

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

// Aggregate nse_equity rows into OHLCV bars at the requested interval.
// rows must be sorted ascending by datetime.
function aggregateBars(rows, interval) {
  if (!rows || rows.length === 0) return [];

  // Returns the bucket key string for a given Date
  function bucketKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (interval === '1d') return dt.toISOString().slice(0, 10);
    if (interval === '1wk') {
      // ISO week: Monday of the week
      const day = dt.getDay(); // 0=Sun
      const diff = (day === 0 ? -6 : 1 - day);
      const mon = new Date(dt);
      mon.setDate(dt.getDate() + diff);
      return mon.toISOString().slice(0, 10);
    }
    if (interval === '1mo') return dt.toISOString().slice(0, 7); // "YYYY-MM"
    return dt.toISOString().slice(0, 10);
  }

  const buckets = new Map();
  for (const r of rows) {
    const dt  = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const key = bucketKey(dt);
    if (!buckets.has(key)) {
      buckets.set(key, { date: key, open: parseFloat(r.open ?? r.close), high: parseFloat(r.high ?? r.close), low: parseFloat(r.low ?? r.close), close: parseFloat(r.close), volume: Number(r.volume ?? 0) });
    } else {
      const b = buckets.get(key);
      b.high   = Math.max(b.high, parseFloat(r.high ?? r.close));
      b.low    = Math.min(b.low,  parseFloat(r.low  ?? r.close));
      b.close  = parseFloat(r.close);
      b.volume += Number(r.volume ?? 0);
    }
  }

  return [...buckets.values()]
    .filter((b) => b.close != null && !isNaN(b.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Same aggregation for nse_index (uses Decimal fields)
function aggregateIndexBars(rows, interval) {
  if (!rows || rows.length === 0) return [];
  const mapped = rows.map((r) => ({
    datetime: r.datetime,
    open:     r.open  != null ? parseFloat(r.open)  : null,
    high:     r.high  != null ? parseFloat(r.high)  : null,
    low:      r.low   != null ? parseFloat(r.low)   : null,
    close:    r.close != null ? parseFloat(r.close) : null,
    volume:   r.volume != null ? Number(r.volume)   : 0,
  }));
  return aggregateBars(mapped, interval);
}

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

    const rawIndicators = indicators.computeAll(
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
      marketData.allTimeLow
    );
  }

  // ── Data Fetching ──────────────────────────────────────────────────────────

  async fetchMarketData(symbol) {
    const now        = Date.now();
    const oneYearAgo = new Date(now - ONE_YEAR_MS);
    const twoYrsAgo  = new Date(now - 2 * ONE_YEAR_MS);
    const threeYrsAgo = new Date(now - 3 * ONE_YEAR_MS);

    // Fetch all equity rows needed across all timeframes in two queries
    const [allDailyRows, allTimeRows] = await Promise.all([
      // 3 years of daily data covers daily (1y), weekly (2y), monthly (3y)
      prisma.nse_equity.findMany({
        where:   { symbol, datetime: { gte: threeYrsAgo } },
        orderBy: { datetime: 'asc' },
        select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true },
      }),
      // All-time monthly for ATH/ATL
      prisma.nse_equity.findMany({
        where:   { symbol },
        orderBy: { datetime: 'asc' },
        select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true },
      }),
    ]);

    // Slice for each timeframe before aggregating
    const dailyRaw   = allDailyRows.filter((r) => new Date(r.datetime) >= oneYearAgo);
    const weeklyRaw  = allDailyRows.filter((r) => new Date(r.datetime) >= twoYrsAgo);
    const monthlyRaw = allDailyRows;

    const dailyBars   = aggregateBars(dailyRaw,   '1d');
    const weeklyBars  = aggregateBars(weeklyRaw,  '1wk');
    const monthlyBars = aggregateBars(monthlyRaw, '1mo');
    const allTimeBars = aggregateBars(allTimeRows, '1mo');

    // Synthetic quote from latest daily bar
    const latest = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1] : null;
    const prev   = dailyBars.length > 1 ? dailyBars[dailyBars.length - 2] : null;
    const quote  = latest
      ? {
          regularMarketPrice:           latest.close,
          regularMarketPreviousClose:   prev?.close ?? latest.open,
          regularMarketOpen:            latest.open,
          regularMarketDayHigh:         latest.high,
          regularMarketDayLow:          latest.low,
          regularMarketVolume:          latest.volume,
          fiftyTwoWeekHigh:             dailyBars.length > 0 ? Math.max(...dailyBars.map((b) => b.high)) : null,
          fiftyTwoWeekLow:              dailyBars.length > 0 ? Math.min(...dailyBars.map((b) => b.low))  : null,
        }
      : null;

    let allTimeHigh = null;
    let allTimeLow  = null;
    if (allTimeBars.length > 0) {
      allTimeHigh = Math.max(...allTimeBars.map((b) => b.high));
      allTimeLow  = Math.min(...allTimeBars.map((b) => b.low));
    }

    return { dailyBars, weeklyBars, monthlyBars, quote, nextEarningsDate: null, allTimeHigh, allTimeLow };
  }

  async fetchWatchlistRow(symbol) {
    try {
      const csv  = await fetchUrl(SHEET_CSV_URL);
      const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
      return rows.find((r) => (r['Stock'] || '').toUpperCase() === symbol) ?? null;
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

    const [niftyRows, sectorRows] = await Promise.all([
      prisma.nse_index.findMany({
        where:   { sector: 'NIFTY 50', datetime: { gte: oneYearAgo } },
        orderBy: { datetime: 'asc' },
        select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true },
      }),
      sectorName
        ? prisma.nse_index.findMany({
            where:   { sector: sectorName, datetime: { gte: oneYearAgo } },
            orderBy: { datetime: 'asc' },
            select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true },
          })
        : Promise.resolve([]),
    ]);

    const niftyBars  = aggregateIndexBars(niftyRows,  '1d');
    const sectorBars = aggregateIndexBars(sectorRows, '1d');

    const vsNifty  = niftyBars.length  > 0 ? this._computeCRS(dailyBars, niftyBars)  : null;
    const vsSector = sectorBars.length > 0
      ? { ...this._computeCRS(dailyBars, sectorBars), sectorTicker: sectorName }
      : null;

    return { vsNifty, vsSector };
  }

  // ── Response builder (unchanged shape) ────────────────────────────────────

  _buildResponse(symbol, raw, finalSignal, timeframes, insights, row, nextEarningsDate, ruleEngineResult, allTimeHigh, allTimeLow) {
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
        low52w:       r2(d.low52w),
        distanceFrom52wHigh: r2(d.distFrom52wHigh),
        distanceFrom52wLow:  r2(d.distFrom52wLow),
        allTimeHigh:      r2(allTimeHigh),
        allTimeLow:       r2(allTimeLow),
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
