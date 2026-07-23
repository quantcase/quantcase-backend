'use strict';

const { parse } = require('csv-parse/sync');
const https     = require('https');

const indicators  = require('../utils/taIndicators');
const { resolveTechnicalIndicators, resolveMetric, createSeriesMapContext } = require('../utils/formulaRegistry/index');
const { fetchOhlcvBars, fetchWyckoffBars } = require('../utils/formulaRegistry/dataFetcherMarket');
const scoring     = require('../utils/taScoring');
const { computeRuleEngine } = require('../utils/taRuleEngine');
const { resolveIndexSymbol, NIFTY_BENCHMARK_SYMBOL } = require('../utils/sectorIndexMap');
const { computeStockTypeStats, detectValidSMA200Cross } = require('../utils/taStockType');
const wyckoff     = require('./wyckoff');
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

/**
 * Read the macro sector from a watchlist row.
 * The sheet header is "MACRO ECONOMIC SECTOR"; older code read "MACRO ECO SECTOR", which
 * silently yielded undefined and disabled all sector-relative strength. Accept both.
 */
function macroSectorOf(row) {
  return row?.['MACRO ECONOMIC SECTOR'] || row?.['MACRO ECO SECTOR'] || null;
}

/**
 * Read the granular basic industry from a watchlist row. This is the primary key
 * for sector-index resolution (see utils/sectorIndexMap.js) — NIFTY sector indices
 * are defined at basic-industry granularity, not at the coarse macro-sector level.
 */
function basicIndustryOf(row) {
  return row?.['BASIC INDUSTRY'] || null;
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

class TechnicalAnalysis {
  constructor() {
    if (TechnicalAnalysis.instance) return TechnicalAnalysis.instance;
    TechnicalAnalysis.instance = this;
  }

  async analyze(symbol) {
    const [marketData, watchlistRow, wyckoffPhase] = await Promise.all([
      this.fetchMarketData(symbol),
      this.fetchWatchlistRow(symbol),
      this.computeWyckoffPhase(symbol),
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
    await this._applyResolverAverages(d, marketData.dailyBars);

    const crsDataPromise = this._fetchCRSData(
      { basicIndustry: basicIndustryOf(watchlistRow), macroSector: macroSectorOf(watchlistRow) },
      marketData.dailyBars
    ).catch(() => ({ vsNifty: null, vsSector: null, vsSectorNifty: null }));

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
    const ruleEngineResult = computeRuleEngine(d, watchlistRow, crsData, wyckoffPhase);

    // Stock-type classification stats + confirmed SMA_200 cross. Both need the full ~3y
    // daily series: a 200-day SMA_200 window requires ~400 bars of warmup, which the
    // 1-year dailyBars slice cannot supply.
    const longBars = marketData.dailyBarsFull ?? marketData.dailyBars;
    const stockTypeStats  = computeStockTypeStats(longBars);
    const validSMA200Cross = detectValidSMA200Cross(longBars);

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
      marketData.low52wDate,
      { stockTypeStats, validSMA200Cross }
    );
  }

  // ── Data Fetching ──────────────────────────────────────────────────────────

  async fetchMarketData(symbol) {
    return fetchOhlcvBars(prisma, symbol);
  }

  /**
   * Overrides sma20/50/100/200 and avgVolume20/30 (+ everything derived from
   * them) with the Kpi-driven resolver's values (SMA_20/50/100/200,
   * AVG_VOL_20/30 -- AVG(PRICE,N)/AVG(VOLUME_DAILY,N), the same formulas
   * getPrices' /prices endpoint uses), so /technicals and /prices report the
   * same number for the same underlying average instead of two
   * independently hand-rolled taIndicators computations that could silently
   * drift. Everything else in `d` (EMA/RSI/MACD/Bollinger/ADX/CMF/
   * crossovers/structure/52w) is left exactly as taIndicators computed it --
   * no formula-grammar primitive exists for those (see the approved plan at
   * ~/.claude/plans/shimmying-skipping-lighthouse.md).
   *
   * Mutates `d` in place, called before any scoring/rule-engine consumes it,
   * so those downstream computations see the resolver-driven values too, not
   * just the final JSON.
   */
  async _applyResolverAverages(d, dailyBars) {
    if (!dailyBars?.length || !d || d.cmp == null) return;

    const resCtx = createSeriesMapContext({
      seriesMap: {
        PRICE:        dailyBars.map((b) => ({ value: b.close })),
        VOLUME_DAILY: dailyBars.map((b) => ({ value: b.volume })),
      },
      frequency: 'daily',
    });

    const [sma20, sma50, sma100, sma200, avgVol20, avgVol30] = await Promise.all([
      resolveMetric('SMA_20', resCtx),
      resolveMetric('SMA_50', resCtx),
      resolveMetric('SMA_100', resCtx),
      resolveMetric('SMA_200', resCtx),
      resolveMetric('AVG_VOL_20', resCtx),
      resolveMetric('AVG_VOL_30', resCtx),
    ]);

    // averageFromSeries doesn't null out on a short window (see
    // createSeriesMapContext's docs -- that's deliberate, other formulas
    // like ROE_3Y_AVG rely on it) -- length-guard here to match
    // taIndicators' "null until enough history exists" convention.
    const n = dailyBars.length;
    d.sma20  = n >= 20  ? sma20.value  : null;
    d.sma50  = n >= 50  ? sma50.value  : null;
    d.sma100 = n >= 100 ? sma100.value : null;
    d.sma200 = n >= 200 ? sma200.value : null;
    d.avgVolume20 = n >= 20 ? avgVol20.value : null;
    d.avgVolume30 = n >= 30 ? avgVol30.value : null;

    // Recompute everything derived from the fields above so the response
    // stays internally consistent (e.g. volumeRatio must match avgVolume20).
    d.aboveSMA20  = d.sma20  != null ? d.cmp > d.sma20  : null;
    d.aboveSMA50  = d.sma50  != null ? d.cmp > d.sma50  : null;
    d.aboveSMA200 = d.sma200 != null ? d.cmp > d.sma200 : null;

    const currentVol = d.volume;
    d.volumeRatio = (d.avgVolume20 && d.avgVolume20 > 0) ? currentVol / d.avgVolume20 : null;
    d.volumeVsAvg30Signal = d.avgVolume30 != null
      ? (currentVol > d.avgVolume30 ? 'ABOVE_AVERAGE' : 'BELOW_AVERAGE')
      : null;
    d.volumeBreakout = d.volumeRatio != null && d.volumeRatio > 1.5;
    const priceChg = d.cmp - d.prevClose;
    d.accumulation = priceChg > 0 && d.volumeBreakout;
    d.distribution = priceChg < 0 && d.volumeBreakout;
  }

  /**
   * Price-derived Wyckoff phase, mapped to the IndicatorRules.WYCKOFF vocabulary.
   *
   * Used only as a fallback for tickers the watchlist sheet has no PHASE for. It
   * displaces scoring.marketPhase(), a five-rule SMA/RSI heuristic that is not Wyckoff
   * at all and can emit CONSOLIDATION — a value WYCKOFF_INDICATOR_RULES has no entry for.
   *
   * Returns null rather than a guess when there isn't enough clean daily history, so the
   * caller falls through to the old heuristic instead of getting an unearned phase.
   */
  async computeWyckoffPhase(symbol) {
    try {
      const allBars = await fetchWyckoffBars(prisma, symbol);
      if (!allBars.length) return null;
      const era = wyckoff.selectContiguousDailyEra(allBars);
      const result = wyckoff.analyzeWyckoff(wyckoff.backAdjustSplits(era.bars).bars);
      if (result.insufficientData) return null;
      return wyckoff.toTaEnumPhase(result.phaseType);
    } catch {
      return null;
    }
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

  /**
   * Resolve a symbol's macro-economic sector from the watchlist sheet.
   * Returns the raw sheet label (e.g. "Information Technology"), or null when the
   * symbol isn't on the sheet / the sheet can't be read. Shares the same 15-minute
   * cached sheet as analyze(), so it is cheap to call from hot endpoints (e.g. CRS
   * on GET /prices). Exposed so callers don't reach into the private macroSectorOf().
   */
  async resolveMacroSector(symbol) {
    const row = await this.fetchWatchlistRow((symbol || '').toUpperCase());
    return macroSectorOf(row);
  }

  /**
   * Resolve a symbol's full watchlist classification — { macroSector, basicIndustry } —
   * from the same 15-minute cached sheet as analyze(). Exposed so lib/crs.js can pick
   * the same comparison index the /technicals leadership table uses (basic industry
   * first, macro sector as fallback). Returns nulls when the symbol isn't on the sheet.
   */
  async resolveClassification(symbol) {
    const row = await this.fetchWatchlistRow((symbol || '').toUpperCase());
    return { macroSector: macroSectorOf(row), basicIndustry: basicIndustryOf(row) };
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

  /**
   * Compute the three CRS legs (stock-vs-NIFTY, stock-vs-sector, sector-vs-NIFTY).
   *
   * Sector selection is delegated to utils/sectorIndexMap.js: it keys off the stock's
   * BASIC INDUSTRY first (so a private bank compares to NIFTY Private Bank, a chemical
   * to NIFTY Chemicals, a cement to NIFTY Cement, etc.) and falls back to the broad
   * MACRO SECTOR index only when the industry has no dedicated one — replacing the old
   * coarse macro-only map that forced cement/chemicals onto NIFTY METAL.
   *
   * Both the benchmark and the sector index are read from nse_equity_new (the current
   * index table), by their exact Prowess symbol. Each leg stays null until that index's
   * daily history is backfilled into nse_equity_new — never an error.
   *
   * @param {{ basicIndustry?: string|null, macroSector?: string|null }} classification
   * @param {Array<{date:string, close:number}>} dailyBars  the stock's daily bars
   */
  async _fetchCRSData(classification, dailyBars) {
    const sectorName = resolveIndexSymbol(classification);
    const since      = new Date(Date.now() - ONE_YEAR_MS);

    const [niftyBars, sectorBars] = await Promise.all([
      this._fetchIndexDailyBars(NIFTY_BENCHMARK_SYMBOL, since),
      sectorName ? this._fetchIndexDailyBars(sectorName, since) : Promise.resolve([]),
    ]);

    const vsNifty  = niftyBars.length  > 0 ? this._computeCRS(dailyBars, niftyBars)  : null;
    const vsSector = sectorBars.length > 0
      ? { ...this._computeCRS(dailyBars, sectorBars), sectorTicker: sectorName }
      : null;
    // Third CRS leg — without it Module 5's 3-way leadership table cannot be matched at all.
    // _computeCRS is generic over any two bar series, and both index series are already fetched.
    const vsSectorNifty = (sectorBars.length > 0 && niftyBars.length > 0)
      ? { ...this._computeCRS(sectorBars, niftyBars), sectorTicker: sectorName }
      : null;

    return { vsNifty, vsSector, vsSectorNifty };
  }

  /**
   * Read an index's daily closes from nse_equity_new since `since`, as [{date, close}]
   * sorted ascending. `date` is derived exactly like aggregateBars' daily bucket key
   * (datetime.toISOString().slice(0,10)) so these bars intersect the stock's dailyBars
   * dates 1:1 inside _computeCRS. Returns [] when the symbol has no rows yet.
   */
  async _fetchIndexDailyBars(symbol, since) {
    const rows = await prisma.nse_equity_new.findMany({
      where:   { symbol, datetime: { gte: since } },
      orderBy: { datetime: 'asc' },
      select:  { datetime: true, close: true },
    });
    return rows
      .filter(r => r.close != null)
      .map(r => ({ date: r.datetime.toISOString().slice(0, 10), close: Number(r.close) }));
  }

  // ── Response builder (unchanged shape) ────────────────────────────────────

  _buildResponse(symbol, raw, finalSignal, timeframes, insights, row, nextEarningsDate, ruleEngineResult, allTimeHigh, allTimeLow, allTimeHighDate, allTimeLowDate, high52wDate, low52wDate, extras = {}) {
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
    // Sheet PHASE wins, then the price-derived Wyckoff engine (already resolved into
    // ruleEngineResult by computeRuleEngine), then the old SMA heuristic as last resort.
    const phase      = (row['PHASE'] || '').toUpperCase()
      || ruleEngineResult?.structureEngine?.marketStructure?.wyckoffPhase
      || scoring.marketPhase(d);

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
        macroSector:     macroSectorOf(row),
        basicIndustry:   row['BASIC INDUSTRY']   || null,
        pe:              row['PE']               || null,
        sheetTrend:      row['TREND']            || null,
        srRange:         row['%S/R RANGE']       || null,
        nextEarningsDate,
      },

      // Step 0 (stock-type classification) inputs. Aggregations are computed here;
      // the Growth/Value/Mixed label is applied downstream from these statistics.
      stockType: {
        stats:            extras.stockTypeStats  ?? null,
        validSMA200Cross: extras.validSMA200Cross ?? null,
      },

      // Percent distance of price from each SMA — drives the Ideal For SMA hierarchy.
      smaDistancePct: {
        sma20:  d.sma20  ? r2(((d.cmp - d.sma20)  / d.sma20)  * 100) : null,
        sma50:  d.sma50  ? r2(((d.cmp - d.sma50)  / d.sma50)  * 100) : null,
        sma100: d.sma100 ? r2(((d.cmp - d.sma100) / d.sma100) * 100) : null,
        sma200: d.sma200 ? r2(((d.cmp - d.sma200) / d.sma200) * 100) : null,
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
