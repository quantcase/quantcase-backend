'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

// ─── Moving Averages ──────────────────────────────────────────────────────────

/**
 * Simple Moving Average over the last `period` values.
 * @param {number[]} closes  sorted oldest→newest
 * @param {number} period
 * @returns {number|null}
 */
function sma(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential Moving Average (last value).
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function ema(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

/**
 * Full EMA series — same length as input, null for warmup positions.
 * Required internally for MACD signal line computation.
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]}
 */
function emaSeries(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    result[i] = val;
  }
  return result;
}

// ─── Crossover Detection ──────────────────────────────────────────────────────

/**
 * Detect the most recent golden cross (SMA50 > SMA200) or death cross (SMA50 < SMA200)
 * within the supplied daily bars. Scans the last 60 positions after SMA200 warmup.
 *
 * @param {number[]} closes  daily closes sorted oldest→newest (≥200 required)
 * @param {string[]} dates   parallel date strings (ISO)
 * @returns {{ goldenCross: boolean, deathCross: boolean, lastCrossoverDate: string|null }}
 */
function detectCrossovers(closes, dates) {
  const none = { goldenCross: false, deathCross: false, lastCrossoverDate: null };
  if (!closes || closes.length < 201) return none;

  let lastCross = null;
  const start = Math.max(200, closes.length - 60);

  for (let i = start; i < closes.length; i++) {
    const s50prev  = sma(closes.slice(0, i),     50);
    const s200prev = sma(closes.slice(0, i),     200);
    const s50curr  = sma(closes.slice(0, i + 1), 50);
    const s200curr = sma(closes.slice(0, i + 1), 200);

    if (s50prev == null || s200prev == null || s50curr == null || s200curr == null) continue;

    if (s50prev < s200prev && s50curr >= s200curr) {
      lastCross = { type: 'golden', date: dates[i] };
    } else if (s50prev > s200prev && s50curr <= s200curr) {
      lastCross = { type: 'death', date: dates[i] };
    }
  }

  if (!lastCross) return none;
  return {
    goldenCross: lastCross.type === 'golden',
    deathCross:  lastCross.type === 'death',
    lastCrossoverDate: lastCross.date,
  };
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

/**
 * RSI using Wilder's smoothing method.
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {number|null}
 */
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  const diffs = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (diffs[i] > 0) avgGain += diffs[i];
    else avgLoss += Math.abs(diffs[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < diffs.length; i++) {
    const g = diffs[i] > 0 ? diffs[i] : 0;
    const l = diffs[i] < 0 ? Math.abs(diffs[i]) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * RSI trend: compare last two RSI values.
 * @param {number[]} closes
 * @returns {'RISING'|'FALLING'|'FLAT'|null}
 */
function rsiTrend(closes) {
  if (!closes || closes.length < 17) return null;
  const prev = rsi(closes.slice(0, -1));
  const curr = rsi(closes);
  if (prev == null || curr == null) return null;
  if (curr > prev + 0.5) return 'RISING';
  if (curr < prev - 0.5) return 'FALLING';
  return 'FLAT';
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

/**
 * MACD(12, 26, 9).
 * @param {number[]} closes
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signal=9]
 * @returns {{ value: number|null, signal: number|null, histogram: number|null, crossover: string }|null}
 */
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;

  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);

  const macdLine = emaFast.map((f, i) =>
    f != null && emaSlow[i] != null ? f - emaSlow[i] : null
  );

  const validMacd = macdLine.filter((v) => v != null);
  if (validMacd.length < signal) return null;

  const sigSeries = emaSeries(validMacd, signal);
  const sigVal  = sigSeries[sigSeries.length - 1];
  const macdVal = validMacd[validMacd.length - 1];

  const prevMacdVal = validMacd[validMacd.length - 2];
  const prevSigVal  = sigSeries[sigSeries.length - 2];

  const histogram     = macdVal != null && sigVal     != null ? macdVal     - sigVal     : null;
  const prevHistogram = prevMacdVal != null && prevSigVal != null ? prevMacdVal - prevSigVal : null;

  let crossover = 'NONE';
  if (macdVal != null && sigVal != null && prevMacdVal != null && prevSigVal != null) {
    if (prevMacdVal < prevSigVal && macdVal >= prevSigVal) crossover = 'BULLISH';
    else if (prevMacdVal > prevSigVal && macdVal <= prevSigVal) crossover = 'BEARISH';
    else if (macdVal > sigVal) crossover = 'ABOVE';
    else crossover = 'BELOW';
  }

  return { value: macdVal, signal: sigVal, histogram, prevHistogram, crossover };
}

// ─── Stochastic ───────────────────────────────────────────────────────────────

/**
 * Stochastic Oscillator %K and %D.
 * @param {Array<{high:number,low:number,close:number}>} bars  sorted oldest→newest
 * @param {number} [kPeriod=14]
 * @param {number} [dPeriod=3]
 * @returns {{ k: number|null, d: number|null, signal: string }|null}
 */
function stochastic(bars, kPeriod = 14, dPeriod = 3) {
  if (!bars || bars.length < kPeriod + dPeriod) return null;

  const kValues = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...slice.map((b) => b.high));
    const lowestLow   = Math.min(...slice.map((b) => b.low));
    const range = highestHigh - lowestLow;
    kValues.push(range === 0 ? 50 : ((bars[i].close - lowestLow) / range) * 100);
  }

  if (kValues.length < dPeriod) return null;

  const dValues = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    dValues.push(kValues.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
  }

  const k = kValues[kValues.length - 1];
  const d = dValues[dValues.length - 1];

  let sig = 'NEUTRAL';
  if (k > d && k < 80) sig = 'BUY';
  else if (k > 80) sig = 'OVERBOUGHT';
  else if (k < 20) sig = 'OVERSOLD';

  return { k, d, signal: sig };
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

/**
 * ATR(14) using Wilder's smoothing.
 * @param {Array<{high:number,low:number,close:number}>} bars
 * @param {number} [period=14]
 * @returns {number|null}
 */
function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const hl  = bars[i].high - bars[i].low;
    const hpc = Math.abs(bars[i].high - bars[i - 1].close);
    const lpc = Math.abs(bars[i].low  - bars[i - 1].close);
    trs.push(Math.max(hl, hpc, lpc));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

/**
 * Bollinger Bands(20, 2).
 * @param {number[]} closes
 * @param {number} [period=20]
 * @param {number} [multiplier=2]
 * @returns {{ upper, middle, lower, width, squeeze }|null}
 */
function bollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;

  const slice  = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper  = middle + multiplier * stdDev;
  const lower  = middle - multiplier * stdDev;
  const width  = middle > 0 ? (upper - lower) / middle : 0;
  const squeeze = width < 0.1;

  return { upper, middle, lower, width, squeeze };
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

/**
 * ADX(14) using Wilder's smoothing.
 * Requires minimum (period * 2) bars.
 * @param {Array<{high:number,low:number,close:number}>} bars
 * @param {number} [period=14]
 * @returns {number|null}
 */
function adx(bars, period = 14) {
  if (!bars || bars.length < period * 2) return null;

  const trValues = [];
  const plusDM   = [];
  const minusDM  = [];

  for (let i = 1; i < bars.length; i++) {
    const hl  = bars[i].high - bars[i].low;
    const hpc = Math.abs(bars[i].high - bars[i - 1].close);
    const lpc = Math.abs(bars[i].low  - bars[i - 1].close);
    trValues.push(Math.max(hl, hpc, lpc));

    const upMove   = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trValues.length < period) return null;

  // Wilder's initial smoothing
  let atrSmooth    = trValues.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSmooth  = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSmooth = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues = [];
  for (let i = period; i < trValues.length; i++) {
    atrSmooth    = atrSmooth    - atrSmooth    / period + trValues[i];
    plusDMSmooth  = plusDMSmooth  - plusDMSmooth  / period + plusDM[i];
    minusDMSmooth = minusDMSmooth - minusDMSmooth / period + minusDM[i];

    const plusDI  = atrSmooth > 0 ? (plusDMSmooth  / atrSmooth) * 100 : 0;
    const minusDI = atrSmooth > 0 ? (minusDMSmooth / atrSmooth) * 100 : 0;
    const diSum   = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxValues.length < period) return null;
  return dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Volume ───────────────────────────────────────────────────────────────────

/**
 * Average volume over the last `period` bars, ignoring zero-volume bars.
 * @param {number[]} volumes
 * @param {number} [period=20]
 * @returns {number|null}
 */
function avgVolume(volumes, period = 20) {
  if (!volumes || volumes.length < period) return null;
  const slice = volumes.slice(-period).filter((v) => v > 0);
  if (slice.length === 0) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Chaikin Money Flow (CMF) over the last `period` bars.
 * CMF = sum(MFV, period) / sum(volume, period)
 * MFV = ((close - low) - (high - close)) / (high - low) * volume
 * @param {Array<{high:number,low:number,close:number,volume:number}>} bars
 * @param {number} [period=20]
 * @returns {number|null}  range roughly -1 to +1
 */
function cmf(bars, period = 20) {
  if (!bars || bars.length < period) return null;
  const slice = bars.slice(-period);
  let sumMFV = 0, sumVol = 0;
  for (const bar of slice) {
    const range = bar.high - bar.low;
    const mfm   = range === 0 ? 0 : ((bar.close - bar.low) - (bar.high - bar.close)) / range;
    sumMFV += mfm * bar.volume;
    sumVol += bar.volume;
  }
  return sumVol === 0 ? null : sumMFV / sumVol;
}

/**
 * Volume trend: compare avg of last 5 bars vs avg of prior 15 bars (±10% threshold).
 * @param {number[]} volumes
 * @returns {'INCREASING'|'DECREASING'|'FLAT'}
 */
function volumeTrend(volumes) {
  if (!volumes || volumes.length < 20) return 'FLAT';
  const recent = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prior  = volumes.slice(-20, -5).reduce((a, b) => a + b, 0) / 15;
  if (prior === 0) return 'FLAT';
  if (recent > prior * 1.1) return 'INCREASING';
  if (recent < prior * 0.9) return 'DECREASING';
  return 'FLAT';
}

// ─── Market Structure ─────────────────────────────────────────────────────────

/**
 * Determine HH/HL market structure by comparing the last 20 bars vs the prior 20.
 * @param {Array<{high:number,low:number}>} bars
 * @returns {{ higherHighs: boolean|null, higherLows: boolean|null }}
 */
function marketStructure(bars) {
  if (!bars || bars.length < 40) return { higherHighs: null, higherLows: null };
  const recent = bars.slice(-20);
  const prior  = bars.slice(-40, -20);
  const recentHigh = Math.max(...recent.map((b) => b.high));
  const priorHigh  = Math.max(...prior.map((b) => b.high));
  const recentLow  = Math.min(...recent.map((b) => b.low));
  const priorLow   = Math.min(...prior.map((b) => b.low));
  return {
    higherHighs: recentHigh > priorHigh,
    higherLows:  recentLow  > priorLow,
  };
}

// ─── Fibonacci Levels ─────────────────────────────────────────────────────────

/**
 * Standard Fibonacci retracement levels between swing low and swing high.
 * @param {number} low
 * @param {number} high
 * @returns {number[]}  prices at 0.236, 0.382, 0.5, 0.618, 0.786 retracements
 */
function fibonacciLevels(low, high) {
  const diff = high - low;
  return [0.236, 0.382, 0.5, 0.618, 0.786].map((ratio) =>
    r2(high - ratio * diff)
  );
}

// ─── Pivot Points ─────────────────────────────────────────────────────────────

/**
 * Classic pivot points from the previous session.
 * @param {number} prevHigh
 * @param {number} prevLow
 * @param {number} prevClose
 * @returns {{ pivot, r1, r2, s1, s2 }}
 */
function pivotPoints(prevHigh, prevLow, prevClose) {
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  return {
    pivot: r2(pivot),
    r1:    r2(2 * pivot - prevLow),
    r2:    r2(pivot + (prevHigh - prevLow)),
    s1:    r2(2 * pivot - prevHigh),
    s2:    r2(pivot - (prevHigh - prevLow)),
  };
}

// ─── computeAll ───────────────────────────────────────────────────────────────

/**
 * Run all indicators on the supplied timeframe bars.
 * Centralises indicator computation for lib/technicalAnalysis.js.
 *
 * @param {Array<{date,open,high,low,close,volume}>} dailyBars   sorted oldest→newest
 * @param {Array<{date,open,high,low,close,volume}>} weeklyBars
 * @param {Array<{date,open,high,low,close,volume}>} monthlyBars
 * @param {object|null} quote   yahooFinance.quote() result
 * @returns {{ daily: object, weekly: object, monthly: object }}
 */
function computeAll(dailyBars, weeklyBars, monthlyBars, quote) {
  return {
    daily:   _computeTimeframe(dailyBars,   quote, true),
    weekly:  _computeTimeframe(weeklyBars,  null,  false),
    monthly: _computeTimeframe(monthlyBars, null,  false),
  };
}

/**
 * Internal: run indicators on one set of bars.
 * @param {Array} bars
 * @param {object|null} quote  only passed for daily (live CMP + 52W data)
 * @param {boolean} full       true = compute all indicators; false = subset only
 */
function _computeTimeframe(bars, quote, full) {
  if (!bars || bars.length === 0) return {};

  const closes  = bars.map((b) => b.close);
  const highs   = bars.map((b) => b.high);
  const lows    = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const dates   = bars.map((b) => b.date);

  const lastBar  = bars[bars.length - 1];
  const prevBar  = bars.length > 1 ? bars[bars.length - 2] : lastBar;

  // Live CMP from quote (daily only), fallback to last close
  const cmp      = (quote && quote.regularMarketPrice) ? quote.regularMarketPrice : lastBar.close;
  const prevClose = prevBar.close;

  const sma20  = sma(closes, 20);
  const sma50  = sma(closes, 50);
  const sma100 = full ? sma(closes, 100) : null;
  const sma200 = full ? sma(closes, 200) : null;
  const ema20  = full ? ema(closes, 20)  : null;
  const ema50  = full ? ema(closes, 50)  : null;

  const rsi14     = rsi(closes);
  const rsiTrend_ = full ? rsiTrend(closes) : null;
  const rsiZone   = rsi14 == null ? 'UNKNOWN'
    : rsi14 >= 70 ? 'OVERBOUGHT'
    : rsi14 <= 30 ? 'OVERSOLD'
    : 'NEUTRAL';

  const macdResult  = full ? macd(closes)       : null;
  const stochResult = full ? stochastic(bars)   : null;
  const atr14       = full ? atr(bars)          : null;
  const bb          = full ? bollingerBands(closes) : null;
  const prevBb      = full ? bollingerBands(closes.slice(0, -1)) : null;
  const prevBbWidth = prevBb ? prevBb.width : null;
  const adx14       = adx(bars);
  const adxPrev     = full ? adx(bars.slice(0, -1)) : null;
  const adxTrend_   = (full && adx14 != null && adxPrev != null)
    ? (adx14 > adxPrev + 0.3 ? 'RISING' : adx14 < adxPrev - 0.3 ? 'FALLING' : 'FLAT')
    : null;
  const cmf20       = full ? cmf(bars) : null;
  const structure   = marketStructure(bars);

  const crossovers  = full ? detectCrossovers(closes, dates)
    : { goldenCross: false, deathCross: false, lastCrossoverDate: null };

  // Volume
  const currentVol  = lastBar.volume;
  const avgVol20    = avgVolume(volumes);
  const avgVol30    = full ? avgVolume(volumes, 30) : null;
  const volRatio    = (avgVol20 && avgVol20 > 0) ? currentVol / avgVol20 : null;
  const volumeVsAvg30Signal = (full && avgVol30 != null)
    ? (currentVol > avgVol30 ? 'ABOVE_AVERAGE' : 'BELOW_AVERAGE')
    : null;
  const volTrend    = volumeTrend(volumes);
  const volBreakout = volRatio != null && volRatio > 1.5;
  const priceChg    = cmp - prevClose;
  const accum       = priceChg > 0 && volBreakout;
  const distrib     = priceChg < 0 && volBreakout;

  // 52W from quote (daily only) or from bars
  const high52w = (quote && quote.fiftyTwoWeekHigh) ? quote.fiftyTwoWeekHigh : Math.max(...highs);
  const low52w  = (quote && quote.fiftyTwoWeekLow)  ? quote.fiftyTwoWeekLow  : Math.min(...lows);

  return {
    // Price
    cmp,
    prevClose,
    open:   lastBar.open,
    high:   lastBar.high,
    low:    lastBar.low,
    volume: currentVol,

    // 52W
    high52w,
    low52w,
    distFrom52wHigh: high52w > 0 ? ((cmp - high52w) / high52w) * 100 : null,
    distFrom52wLow:  low52w  > 0 ? ((cmp - low52w)  / low52w)  * 100 : null,

    // MAs
    sma20, sma50, sma100, sma200, ema20, ema50,
    aboveSMA20:  sma20  != null ? cmp > sma20  : null,
    aboveSMA50:  sma50  != null ? cmp > sma50  : null,
    aboveSMA200: sma200 != null ? cmp > sma200 : null,

    // Crossovers
    goldenCross:       crossovers.goldenCross,
    deathCross:        crossovers.deathCross,
    lastCrossoverDate: crossovers.lastCrossoverDate,

    // Momentum
    rsi14,
    rsiZone,
    rsiTrend:  rsiTrend_,
    macdValue:     macdResult ? macdResult.value     : null,
    macdSignal:    macdResult ? macdResult.signal    : null,
    macdHistogram: macdResult ? macdResult.histogram : null,
    macdCrossover: macdResult ? macdResult.crossover : null,
    stochK:        stochResult ? stochResult.k       : null,
    stochD:        stochResult ? stochResult.d       : null,
    stochSignal:   stochResult ? stochResult.signal  : null,

    // Volatility
    atr14,
    atrPercent: (cmp > 0 && atr14 != null) ? (atr14 / cmp) * 100 : null,
    bbUpper:   bb ? bb.upper   : null,
    bbMiddle:  bb ? bb.middle  : null,
    bbLower:   bb ? bb.lower   : null,
    bbWidth:   bb ? bb.width   : null,
    bbSqueeze: bb ? bb.squeeze : null,
    prevBbWidth,

    // Trend structure
    adx14,
    adxTrend: adxTrend_,
    higherHighs: structure.higherHighs,
    higherLows:  structure.higherLows,

    // Volume
    avgVolume20: avgVol20,
    avgVolume30: avgVol30,
    volumeVsAvg30Signal,
    volumeRatio: volRatio,
    volumeTrend: volTrend,
    volumeBreakout: volBreakout,
    accumulation:   accum,
    distribution:   distrib,

    // Capital Participation (CMF)
    cmf20,
  };
}

module.exports = {
  sma,
  ema,
  emaSeries,
  detectCrossovers,
  rsi,
  rsiTrend,
  macd,
  stochastic,
  atr,
  bollingerBands,
  adx,
  cmf,
  avgVolume,
  volumeTrend,
  marketStructure,
  fibonacciLevels,
  pivotPoints,
  computeAll,
};
