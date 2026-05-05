'use strict';

const classification = require('../../config/iitClassification.json');

const WINSORISE_SIGMA = 3;
const FACTORS = ['momentum', 'growth', 'profitability', 'balance_sheet', 'breadth', 'sentiment', 'valuation'];

// ─── Math helpers ─────────────────────────────────────────────────────────────

function avg(values) {
  const v = values.filter(x => x != null && isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function winsorise(values) {
  const valid = values.filter(v => v != null && isFinite(v));
  if (valid.length < 4) return values;
  const mean = avg(valid);
  const std  = Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
  if (std === 0) return values;
  const lo = mean - WINSORISE_SIGMA * std;
  const hi = mean + WINSORISE_SIGMA * std;
  return values.map(v => v == null || !isFinite(v) ? null : Math.max(lo, Math.min(hi, v)));
}

// ─── Cross-sectional percentile ranking ──────────────────────────────────────

/**
 * Assign a 0–100 percentile score to each item in {ticker, value}[].
 * Null values receive null scores.
 * higherIsBetter=false inverts the ranking (lowest value → score 100).
 */
function percentileRankAll(items, higherIsBetter = true) {
  const valid = items.filter(x => x.value != null && isFinite(x.value));
  if (!valid.length) return items.map(x => ({ ...x, score: null }));

  const winsorised = winsorise(valid.map(x => x.value));
  const wMap       = new Map(valid.map((x, i) => [x.ticker, winsorised[i]]));

  const sorted = [...valid]
    .map(x => ({ ticker: x.ticker, wv: wMap.get(x.ticker) }))
    .sort((a, b) => a.wv - b.wv); // ascending

  const n = sorted.length;
  const scoreMap = new Map();
  sorted.forEach((item, idx) => {
    const pct = n === 1 ? 50 : (idx / (n - 1)) * 100;
    scoreMap.set(item.ticker, higherIsBetter ? pct : 100 - pct);
  });

  return items.map(x => ({
    ...x,
    score: x.value != null && isFinite(x.value)
      ? Math.round(scoreMap.get(x.ticker) * 10) / 10
      : null,
  }));
}

// Build a Map<ticker, score> from an array of {ticker, value}, ranked cross-sectionally.
function crossRank(tickerValuePairs, higherIsBetter = true) {
  const ranked = percentileRankAll(tickerValuePairs, higherIsBetter);
  return new Map(ranked.map(x => [x.ticker, x.score]));
}

// ─── Regime-adjusted, normalised factor weights ───────────────────────────────

/**
 * Return normalised weights (sum = 1.0) for only the available factors.
 * Base weights come from classification.json; regime deltas are applied additively.
 */
function computeWeights(economicModel, regime, availableFactors) {
  const base   = classification.factor_weights[economicModel] ?? classification.factor_weights['Consumption'];
  const regAdj = classification.regime_adjustments[regime]   ?? {};

  const adjusted = Object.fromEntries(
    Object.entries(base).map(([f, w]) => [f, Math.max(0, w + (regAdj[f] ?? 0))])
  );

  const active = availableFactors.filter(f => adjusted[f] > 0);
  const total  = active.reduce((s, f) => s + adjusted[f], 0);
  if (total === 0) return {};

  return Object.fromEntries(active.map(f => [f, adjusted[f] / total]));
}

// ─── Per-stock factor score assembly ─────────────────────────────────────────

/**
 * Assemble the 7 factor scores for one ticker from pre-computed rank maps.
 * All rank maps are Map<ticker, score 0–100 | null>.
 */
function buildFactorScores(ticker, ranks) {
  const pick = (map) => map?.get(ticker) ?? null;

  const momentum_score = avg([pick(ranks.rel3m), pick(ranks.rel6m), pick(ranks.rel12m)]);

  const growth_score = avg([pick(ranks.rev_yoy), pick(ranks.pat_yoy)]);

  const profitability_score = avg([
    pick(ranks.roce), pick(ranks.ebit_margin), pick(ranks.roe), pick(ranks.roa),
  ]);

  // Balance sheet: each sub-metric ranked independently, then averaged
  const balance_sheet_score = avg([pick(ranks.de), pick(ranks.cr), pick(ranks.ic)]);

  const breadth_score    = pick(ranks.above_20w);
  const sentiment_score  = null; // no analyst data
  const valuation_score  = pick(ranks.val);

  const data_flags = {};
  if (sentiment_score  == null) data_flags.sentiment  = 'missing';
  if (momentum_score   == null) data_flags.momentum   = 'no_price_data';
  if (valuation_score  == null) data_flags.valuation  = 'no_pe_data';
  if (growth_score     == null) data_flags.growth     = 'no_prowess_data';

  return {
    momentum_score,
    growth_score,
    profitability_score,
    balance_sheet_score,
    breadth_score,
    sentiment_score,
    valuation_score,
    data_flags: Object.keys(data_flags).length ? data_flags : null,
  };
}

/**
 * Compute the composite score (0–100) for a stock, applying model-specific and
 * regime-adjusted weights, re-normalised over only the available factors.
 *
 * @returns {{ composite_score: number|null, factor_weights: object|null }}
 */
function computeComposite(factorScores, economicModel, regime) {
  const available = FACTORS.filter(f => factorScores[`${f}_score`] != null);
  const weights   = computeWeights(economicModel, regime, available);
  if (!Object.keys(weights).length) return { composite_score: null, factor_weights: null };

  const composite = available.reduce((sum, f) => {
    return sum + (weights[f] ?? 0) * factorScores[`${f}_score`];
  }, 0);

  return {
    composite_score: Math.round(composite * 10) / 10,
    factor_weights:  weights,
  };
}

/**
 * Build all cross-sectional rank maps from raw metric arrays indexed by ticker.
 *
 * @param {string[]}         tickers
 * @param {Map<string,any>}  fundMap   ticker → computeFundamentals result
 * @param {Map<string,any>}  techMap   ticker → computeTechnicals result
 * @param {Map<string,any>}  valMap    ticker → valuation score (own-history percentile)
 * @returns {Record<string, Map<string, number|null>>}
 */
function buildRankMaps(tickers, fundMap, techMap, valMap) {
  const pairs = (fn, higherIsBetter = true) => {
    const items = tickers.map(t => ({ ticker: t, value: fn(t) }));
    return crossRank(items, higherIsBetter);
  };

  return {
    rel3m:       pairs(t => techMap.get(t)?.rel3m),
    rel6m:       pairs(t => techMap.get(t)?.rel6m),
    rel12m:      pairs(t => techMap.get(t)?.rel12m),
    // Binary signal: map directly to 100/0 instead of cross-ranking to avoid
    // arbitrary score spread among stocks that share the same 0 or 1 value.
    above_20w:   new Map(tickers.map(t => {
      const v = techMap.get(t)?.above_20w;
      return [t, v != null ? (v === 1 ? 100 : 0) : null];
    })),
    rev_yoy:     pairs(t => fundMap.get(t)?.rev_yoy),
    pat_yoy:     pairs(t => fundMap.get(t)?.pat_yoy),
    roce:        pairs(t => fundMap.get(t)?.roce),
    ebit_margin: pairs(t => fundMap.get(t)?.ebit_margin),
    roe:         pairs(t => fundMap.get(t)?.roe),
    roa:         pairs(t => fundMap.get(t)?.roa),
    de:          pairs(t => fundMap.get(t)?.de,  false), // lower DE = better
    cr:          pairs(t => fundMap.get(t)?.cr),
    ic:          pairs(t => fundMap.get(t)?.ic),
    val:         pairs(t => valMap.get(t)),
  };
}

module.exports = { buildFactorScores, computeComposite, computeWeights, buildRankMaps, avg, FACTORS };
