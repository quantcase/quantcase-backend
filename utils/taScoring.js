'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

// ─── Signal Mapping ───────────────────────────────────────────────────────────

/**
 * Map a 0–100 score to a signal label.
 * @param {number|null} score
 * @returns {'BUY'|'WEAK_BUY'|'NEUTRAL'|'WEAK_SELL'|'SELL'}
 */
function getSignal(score) {
  if (score == null) return 'NEUTRAL';
  if (score >= 65) return 'BUY';
  if (score >= 55) return 'WEAK_BUY';
  if (score >= 45) return 'NEUTRAL';
  if (score >= 35) return 'WEAK_SELL';
  return 'SELL';
}

// ─── Component Scorers ────────────────────────────────────────────────────────

/**
 * Trend score (0–100).
 * Formula: (priceVsMA * 0.5) + (adxScore * 0.3) + (structureScore * 0.2)
 *
 * @param {{ cmp, sma20, sma50, sma200, adx14, higherHighs, higherLows }} d
 * @returns {number}
 */
function scoreTrend(d) {
  // 1. Price vs MAs (0–100)
  let pvma = 0;
  if (d.sma20  != null && d.cmp > d.sma20)  pvma += 20;
  if (d.sma50  != null && d.cmp > d.sma50)  pvma += 30;
  if (d.sma200 != null && d.cmp > d.sma200) pvma += 50;

  // 2. ADX strength
  let adxScore = 20;
  if (d.adx14 != null) {
    if (d.adx14 >= 35)      adxScore = 100;
    else if (d.adx14 >= 25) adxScore = 70;
    else if (d.adx14 >= 20) adxScore = 40;
    else                    adxScore = 20;
  }

  // 3. Market structure
  let structScore = 50;
  if (d.higherHighs != null && d.higherLows != null) {
    if (d.higherHighs && d.higherLows)   structScore = 100;
    else if (!d.higherHighs && !d.higherLows) structScore = 20;
    else                                      structScore = 50;
  }

  return r2(pvma * 0.5 + adxScore * 0.3 + structScore * 0.2);
}

/**
 * Momentum score (0–100).
 * Formula: (rsiScore * 0.4) + (macdScore * 0.4) + (stochScore * 0.2)
 *
 * @param {{ rsi14, rsiTrend, macdValue, macdSignal, macdHistogram, macdCrossover, stochK, stochD }} d
 * @returns {number}
 */
function scoreMomentum(d) {
  // RSI score
  let rsiScore = 50;
  if (d.rsi14 != null) {
    if (d.rsi14 < 30)      rsiScore = 80;  // oversold → bullish potential
    else if (d.rsi14 < 45) rsiScore = 60;
    else if (d.rsi14 < 55) rsiScore = 50;
    else if (d.rsi14 < 70) rsiScore = 70;  // bullish momentum zone
    else                   rsiScore = 40;  // overbought risk
    if (d.rsiTrend === 'RISING') rsiScore = Math.min(100, rsiScore + 5);
  }

  // MACD score
  let macdScore = 50;
  if (d.macdValue != null && d.macdSignal != null) {
    if (d.macdValue > d.macdSignal && d.macdHistogram > 0) macdScore = 100;
    else if (d.macdCrossover === 'BULLISH')                 macdScore = 90;
    else if (d.macdValue > d.macdSignal)                    macdScore = 70;
    else if (d.macdCrossover === 'ABOVE')                   macdScore = 65;
    else if (d.macdHistogram != null && d.macdHistogram > -0.01) macdScore = 50; // narrowing
    else if (d.macdCrossover === 'BEARISH')                 macdScore = 15;
    else                                                    macdScore = 20;
  }

  // Stochastic score
  let stochScore = 50;
  if (d.stochK != null && d.stochD != null) {
    if (d.stochK > d.stochD && d.stochK < 80) stochScore = 80;
    else if (d.stochK > 80)                    stochScore = 40;
    else if (d.stochK < 20)                    stochScore = 70;  // oversold bounce potential
    else                                       stochScore = 50;
  }

  return r2(rsiScore * 0.4 + macdScore * 0.4 + stochScore * 0.2);
}

/**
 * Volume score (0–100).
 * Formula: (ratioScore * 0.5) + (trendScore * 0.3) + (breakoutScore * 0.2)
 *
 * @param {{ volumeRatio, volumeTrend, volumeBreakout }} d
 * @returns {number}
 */
function scoreVolume(d) {
  let ratioScore = 30;
  if (d.volumeRatio != null) {
    if (d.volumeRatio > 1.5)      ratioScore = 100;
    else if (d.volumeRatio > 1.2) ratioScore = 80;
    else if (d.volumeRatio > 1.0) ratioScore = 60;
    else                          ratioScore = 30;
  }

  const trendScore = d.volumeTrend === 'INCREASING' ? 80
    : d.volumeTrend === 'FLAT'                       ? 50
    : 20;

  const breakoutScore = d.volumeBreakout ? 100 : 40;

  return r2(ratioScore * 0.5 + trendScore * 0.3 + breakoutScore * 0.2);
}

/**
 * Volatility score (0–100).
 * Not directional — measures quality/setup of the chart.
 * Formula: (bbScore * 0.5) + (atrScore * 0.3) + (squeezeScore * 0.2)
 *
 * @param {{ bbWidth, atrPercent, bbSqueeze }} d
 * @returns {number}
 */
function scoreVolatility(d) {
  let bbScore = 40;
  if (d.bbWidth != null) {
    if (d.bbWidth < 0.1)      bbScore = 90;  // tight squeeze
    else if (d.bbWidth < 0.2) bbScore = 70;
    else                      bbScore = 40;
  }

  let atrScore = 60;
  if (d.atrPercent != null) {
    if (d.atrPercent < 2)      atrScore = 80;  // low vol → clean moves
    else if (d.atrPercent < 4) atrScore = 60;
    else                       atrScore = 40;
  }

  const squeezeScore = d.bbSqueeze ? 100 : 50;

  return r2(bbScore * 0.5 + atrScore * 0.3 + squeezeScore * 0.2);
}

// ─── Final Signal ─────────────────────────────────────────────────────────────

/**
 * Weighted composite score and overall signal.
 * Weights: trend 30%, momentum 30%, volume 20%, volatility 20%
 *
 * @param {{ trendScore, momentumScore, volumeScore, volatilityScore }} scores
 * @returns {{ score: number, overall: string, components: object }}
 */
function computeFinalSignal(scores) {
  const { trendScore, momentumScore, volumeScore, volatilityScore } = scores;
  const score = r2(
    (trendScore      || 0) * 0.30 +
    (momentumScore   || 0) * 0.30 +
    (volumeScore     || 0) * 0.20 +
    (volatilityScore || 0) * 0.20
  );
  return {
    score,
    overall: getSignal(score),
    components: {
      trend:      trendScore,
      momentum:   momentumScore,
      volume:     volumeScore,
      volatility: volatilityScore,
    },
  };
}

// ─── Trend Classification ─────────────────────────────────────────────────────

/**
 * Derive UPTREND / DOWNTREND / SIDEWAYS from MA alignment and structure.
 * @param {{ cmp, sma20, sma50, sma200, higherHighs, higherLows, adx14 }} d
 * @returns {'UPTREND'|'DOWNTREND'|'SIDEWAYS'}
 */
function trendDirection(d) {
  if (d.adx14 != null && d.adx14 < 20) return 'SIDEWAYS';
  if (d.higherHighs && d.higherLows)   return 'UPTREND';
  if (!d.higherHighs && !d.higherLows) return 'DOWNTREND';
  // Mixed structure — fall back to MA alignment
  if (d.sma50 != null && d.sma200 != null) {
    if (d.cmp > d.sma50 && d.sma50 > d.sma200) return 'UPTREND';
    if (d.cmp < d.sma50 && d.sma50 < d.sma200) return 'DOWNTREND';
  }
  return 'SIDEWAYS';
}

/**
 * Trend strength from ADX value.
 * @param {number|null} adx14
 * @returns {'STRONG'|'MODERATE'|'WEAK'|null}
 */
function trendStrength(adx14) {
  if (adx14 == null) return null;
  if (adx14 >= 35)      return 'STRONG';
  if (adx14 >= 25)      return 'MODERATE';
  if (adx14 >= 20)      return 'WEAK';
  return 'WEAK';
}

/**
 * Market phase heuristic from price/MA/volume context.
 * @param {{ cmp, sma200, sma50, higherHighs, higherLows, volumeTrend, rsi14 }} d
 * @returns {'ACCUMULATION'|'MARKUP'|'DISTRIBUTION'|'MARKDOWN'|'CONSOLIDATION'}
 */
function marketPhase(d) {
  const aboveSMA200 = d.sma200 != null && d.cmp > d.sma200;
  const aboveSMA50  = d.sma50  != null && d.cmp > d.sma50;

  if (aboveSMA200 && aboveSMA50 && d.higherHighs && d.higherLows) return 'MARKUP';
  if (!aboveSMA200 && !d.higherHighs && !d.higherLows)            return 'MARKDOWN';
  if (!aboveSMA200 && d.volumeTrend === 'INCREASING')             return 'ACCUMULATION';
  if (aboveSMA200 && d.volumeTrend === 'DECREASING' && d.rsi14 != null && d.rsi14 > 60) return 'DISTRIBUTION';
  return 'CONSOLIDATION';
}

// ─── Dynamic S/R ──────────────────────────────────────────────────────────────

/**
 * Classify MAs as acting as support or resistance relative to current price.
 * @param {number} cmp
 * @param {{ sma20, sma50, sma100, sma200 }} mas
 * @returns {{ support: string[], resistance: string[] }}
 */
function dynamicSupportResistance(cmp, mas) {
  const support    = [];
  const resistance = [];
  const pairs = [
    ['SMA20',  mas.sma20],
    ['SMA50',  mas.sma50],
    ['SMA100', mas.sma100],
    ['SMA200', mas.sma200],
  ];
  for (const [label, val] of pairs) {
    if (val == null) continue;
    if (cmp > val) support.push(label);
    else           resistance.push(label);
  }
  return { support, resistance };
}

// ─── Timeframes ───────────────────────────────────────────────────────────────

/**
 * Compute per-timeframe trend direction and signal for the timeframes block.
 * @param {object} dailyInd    output of taIndicators._computeTimeframe for daily
 * @param {object} weeklyInd   output for weekly
 * @param {object} monthlyInd  output for monthly
 * @returns {object}
 */
function computeTimeframes(dailyInd, weeklyInd, monthlyInd) {
  const dailyDir   = trendDirection(dailyInd);
  const weeklyDir  = weeklyInd  && Object.keys(weeklyInd).length  ? trendDirection(weeklyInd)  : 'UNKNOWN';
  const monthlyDir = monthlyInd && Object.keys(monthlyInd).length ? trendDirection(monthlyInd) : 'UNKNOWN';

  // Per-timeframe scores for signal derivation
  const dailyScore = r2(
    scoreTrend(dailyInd) * 0.30 +
    scoreMomentum(dailyInd) * 0.30 +
    scoreVolume(dailyInd) * 0.20 +
    scoreVolatility(dailyInd) * 0.20
  );

  const weeklyScore = weeklyInd && Object.keys(weeklyInd).length ? r2(
    scoreTrend(weeklyInd) * 0.50 +
    scoreMomentum(weeklyInd) * 0.30 +
    scoreVolume(weeklyInd) * 0.20
  ) : 50;

  const monthlyScore = monthlyInd && Object.keys(monthlyInd).length ? r2(
    scoreTrend(monthlyInd) * 0.60 +
    scoreMomentum(monthlyInd) * 0.40
  ) : 50;

  // Multi-timeframe composite: daily 50%, weekly 30%, monthly 20%
  const mtfScore = r2(dailyScore * 0.5 + weeklyScore * 0.3 + monthlyScore * 0.2);

  return {
    daily: {
      trend:  dailyDir,
      signal: getSignal(dailyScore),
    },
    weekly: {
      trend:  weeklyDir,
      signal: getSignal(weeklyScore),
    },
    monthly: {
      trend:  monthlyDir,
      signal: getSignal(monthlyScore),
    },
    multiTimeframeSignal: getSignal(mtfScore),
    multiTimeframeScore:  mtfScore,
    timeframeSignals: {
      shortTerm:  getSignal(r2(scoreMomentum(dailyInd) * 0.6 + scoreVolume(dailyInd) * 0.4)),
      mediumTerm: getSignal(r2(scoreTrend(dailyInd) * 0.5 + scoreMomentum(dailyInd) * 0.3 + scoreVolume(dailyInd) * 0.2)),
      longTerm:   getSignal(r2(scoreTrend(dailyInd) * 0.7 + scoreVolatility(dailyInd) * 0.3)),
    },
  };
}

// ─── Insight Generator ────────────────────────────────────────────────────────

/**
 * Deterministic rule-based insights.
 * @param {object} d  daily indicators from computeAll
 * @returns {string[]}
 */
function generateInsights(d) {
  const insights = [];

  // Long-term MA
  if (d.sma200 != null && d.cmp < d.sma200)
    insights.push('Price trading below 200 DMA — long-term trend remains weak');
  if (d.sma200 != null && d.cmp > d.sma200)
    insights.push('Price above 200 DMA — long-term trend is supportive');

  // Medium-term MA
  if (d.sma50 != null && d.sma200 != null && d.cmp < d.sma50 && d.cmp > d.sma200)
    insights.push('Price between SMA50 and SMA200 — watch for medium-term direction');

  // RSI
  if (d.rsi14 != null && d.rsi14 < 35)
    insights.push('RSI in oversold zone — potential mean reversion setup');
  if (d.rsi14 != null && d.rsi14 > 70)
    insights.push('RSI overbought — momentum may be exhausting');
  if (d.rsiTrend === 'RISING' && d.rsi14 != null && d.rsi14 < 65)
    insights.push('RSI rising from neutral — early momentum building');

  // MACD
  if (d.macdCrossover === 'BULLISH')
    insights.push('MACD bullish crossover — momentum turning positive');
  if (d.macdCrossover === 'BEARISH')
    insights.push('MACD bearish crossover — momentum turning negative');
  if (d.macdValue != null && d.macdSignal != null && d.macdValue > d.macdSignal && d.macdHistogram > 0)
    insights.push('MACD above signal with positive histogram — bullish momentum confirmed');

  // Volume
  if (d.volumeBreakout)
    insights.push('Volume spike above 20-day average — confirms momentum or breakout');
  if (d.accumulation)
    insights.push('Price rising on high volume — accumulation signal');
  if (d.distribution)
    insights.push('Price falling on high volume — distribution signal');

  // Bollinger Bands
  if (d.bbSqueeze)
    insights.push('Bollinger Band squeeze detected — expect a sharp directional move soon');

  // ADX / Trend
  if (d.adx14 != null && d.adx14 < 20)
    insights.push('ADX below 20 — market is in a weak trend or ranging phase');
  if (d.adx14 != null && d.adx14 > 35)
    insights.push('ADX above 35 — strong trending environment, favour trend-following entries');

  // Golden / Death cross
  if (d.goldenCross)
    insights.push('Golden cross recently confirmed (SMA50 > SMA200) — long-term bullish signal');
  if (d.deathCross)
    insights.push('Death cross recently confirmed (SMA50 < SMA200) — long-term bearish signal');

  // Market structure
  if (d.higherHighs && d.higherLows)
    insights.push('Market structure shows higher highs and higher lows — bullish bias');
  if (d.higherHighs != null && d.higherLows != null && !d.higherHighs && !d.higherLows)
    insights.push('Market structure shows lower highs and lower lows — bearish bias');

  // 52W distance
  if (d.distFrom52wHigh != null && d.distFrom52wHigh < -25)
    insights.push(`Price is ${Math.abs(d.distFrom52wHigh).toFixed(1)}% below its 52-week high — significant correction underway`);
  if (d.distFrom52wLow != null && d.distFrom52wLow < 10)
    insights.push('Price near 52-week low — elevated risk; watch key support levels closely');

  return insights;
}

module.exports = {
  getSignal,
  scoreTrend,
  scoreMomentum,
  scoreVolume,
  scoreVolatility,
  computeFinalSignal,
  trendDirection,
  trendStrength,
  marketPhase,
  dynamicSupportResistance,
  computeTimeframes,
  generateInsights,
};
