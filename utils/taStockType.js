'use strict';

/**
 * Stock-type classification statistics.
 *
 * Implements the deterministic aggregations from stock-type-identification.md Step 0A
 * (conditions C1-C5). The *thresholds* and the final Growth/Value/Mixed label are applied
 * by the LLM in Step 0 of the technical-intelligence prompt — this module only computes
 * the summary statistics, because 100-day percentage counts and touch counts are exactly
 * the kind of aggregation that is unreliable when done over a raw array in-context.
 *
 * Sending six scalars instead of ~400 raw indicator values keeps the prompt ~2,000 tokens
 * lighter per stock.
 */

const indicators = require('./taIndicators');

/** Round to 2dp, null-safe. */
function r2(v) {
  return v != null && isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/**
 * Mean of the last n non-null values in a series.
 * @param {(number|null)[]} series
 * @param {number} n
 */
function _meanOfLast(series, n) {
  const vals = series.filter((v) => v != null).slice(-n);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Percentage (0-100) of the last n non-null values satisfying a predicate.
 * Returns null when there is no data to measure — never 0, which would read as
 * a real "0% of days" signal and could wrongly push a classification.
 */
function _pctOfLast(series, n, predicate) {
  const vals = series.filter((v) => v != null).slice(-n);
  if (vals.length === 0) return null;
  return (vals.filter(predicate).length / vals.length) * 100;
}

/**
 * Compute the Step 0A classification statistics.
 *
 * @param {Array<{date:string,open:number,high:number,low:number,close:number,volume:number}>} bars
 *        Daily bars, oldest→newest. Should be the FULL ~3y series (dailyBarsFull), not the
 *        1-year window: C3 needs 200 days of *defined* SMA_200, which needs ~400 bars.
 * @returns {object|null} stats, or null when there is not enough history
 */
function computeStockTypeStats(bars) {
  if (!Array.isArray(bars) || bars.length < 200) return null;

  const closes = bars.map((b) => b.close);

  const adxSer = indicators.adxSeries(bars);
  const rsiSer = indicators.rsiSeries(closes);
  const sma200Ser = indicators.smaSeries(closes, 200);
  const sma50Ser = indicators.smaSeries(closes, 50);

  // C1 — mean ADX over the last 100 days
  const adx100Avg = _meanOfLast(adxSer, 100);

  // C2 — RSI distribution over the last 100 days
  const rsiAbove55Pct = _pctOfLast(rsiSer, 100, (v) => v > 55);
  const rsiBelow50Pct = _pctOfLast(rsiSer, 100, (v) => v < 50);

  // C3 — SMA_200 touch count over the last 200 days.
  // Doc definition of a touch: low[day] <= SMA_200[day] <= high[day].
  let sma200TouchCount = null;
  let sma200TouchWindow = 0;
  {
    const idxs = [];
    for (let i = 0; i < bars.length; i++) {
      if (sma200Ser[i] != null) idxs.push(i);
    }
    const window = idxs.slice(-200);
    sma200TouchWindow = window.length;
    if (window.length > 0) {
      sma200TouchCount = window.filter((i) => {
        const s = sma200Ser[i];
        return bars[i].low <= s && s <= bars[i].high;
      }).length;
    }
  }

  // C4 — SMA_50 slope direction counts over the last 100 days (99 day-over-day diffs)
  let sma50UpPct = null;
  let sma50DownPct = null;
  {
    const defined = [];
    for (let i = 0; i < sma50Ser.length; i++) {
      if (sma50Ser[i] != null) defined.push(sma50Ser[i]);
    }
    const window = defined.slice(-100);
    if (window.length > 1) {
      let up = 0;
      let down = 0;
      for (let i = 1; i < window.length; i++) {
        if (window[i] > window[i - 1]) up++;
        else if (window[i] < window[i - 1]) down++;
      }
      const diffs = window.length - 1;
      sma50UpPct = (up / diffs) * 100;
      sma50DownPct = (down / diffs) * 100;
    }
  }

  // C5 — price vs SMA_200 distance today
  const lastClose = closes.at(-1);
  const lastSma200 = [...sma200Ser].reverse().find((v) => v != null) ?? null;
  const sma200DistancePct =
    lastSma200 != null && lastSma200 > 0
      ? ((lastClose - lastSma200) / lastSma200) * 100
      : null;

  return {
    adx100Avg: r2(adx100Avg),
    rsiAbove55Pct: r2(rsiAbove55Pct),
    rsiBelow50Pct: r2(rsiBelow50Pct),
    sma200TouchCount,
    sma200TouchWindow, // how many days the touch count was actually measured over
    sma50UpPct: r2(sma50UpPct),
    sma50DownPct: r2(sma50DownPct),
    sma200DistancePct: r2(sma200DistancePct),
    barsAvailable: bars.length,
  };
}

/**
 * Detect a valid, confirmed cross of price above SMA_200.
 *
 * Scoring-critical: Module 2 scores a fresh confirmed cross at 18 (Growth) versus 16 for
 * merely holding above, so a false positive is an 8-point error. Conditions kept strict:
 *   1. price closed above SMA_200 today
 *   2. price closed below SMA_200 at some point within the lookback
 *   3. it has stayed above since the cross (no re-cross below)
 *   4. the cross is recent (within `lookback` bars) — an old cross is "holding", not "crossing"
 *
 * @param {Array<{close:number}>} bars daily bars oldest→newest
 * @param {number} [lookback=30]
 * @returns {boolean|null} null when there is insufficient history to judge
 */
function detectValidSMA200Cross(bars, lookback = 30) {
  if (!Array.isArray(bars) || bars.length < 220) return null;

  const closes = bars.map((b) => b.close);
  const sma200 = indicators.smaSeries(closes, 200);

  const idxs = [];
  for (let i = 0; i < bars.length; i++) {
    if (sma200[i] != null) idxs.push(i);
  }
  if (idxs.length < 2) return null;

  const last = idxs.at(-1);
  if (!(closes[last] > sma200[last])) return false; // not above today

  const window = idxs.slice(-(lookback + 1));
  let crossedUpAt = -1;
  for (let k = 1; k < window.length; k++) {
    const prev = window[k - 1];
    const cur = window[k];
    if (closes[prev] <= sma200[prev] && closes[cur] > sma200[cur]) crossedUpAt = k;
  }
  if (crossedUpAt === -1) return false; // no cross inside the lookback → holding, not crossing

  // Must have stayed above since the cross
  for (let k = crossedUpAt; k < window.length; k++) {
    const i = window[k];
    if (closes[i] <= sma200[i]) return false;
  }
  return true;
}

module.exports = { computeStockTypeStats, detectValidSMA200Cross };
