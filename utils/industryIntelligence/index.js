'use strict';

const prisma                                    = require('../../config/prisma');
const { ProwessHelper }                         = require('../prowessHelper');
const { FinHelper }                             = require('../finHelper');
const classification                            = require('../../config/iitClassification.json');
const { loadUniverse, warmProwessCache }        = require('./universe');
const { computeTechnicals }                     = require('./technicals');
const { computeFundamentals }                   = require('./fundamentals');
const { computeValuation }                      = require('./valuation');
const { buildRankMaps, buildFactorScores, computeComposite } = require('./scoring');
const { computeClusterScores, rankClusters, attachWoWDeltas } = require('./clusterScoring');
const { saveStockScores, saveClusterScores }    = require('./persist');

const FUNDAMENTALS_CONCURRENCY = 15;

// Run `fn` over `items` with at most `limit` in-flight at once.
async function pMap(items, fn, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run a full IIT scoring pass for a given week and persist results.
 *
 * @param {{ weekDate: string, regime?: string }} options
 *   weekDate — 'YYYY-MM-DD' (Friday of the scoring week)
 *   regime   — 'Risk-On' | 'Neutral' | 'Risk-Off'  (default 'Neutral')
 */
async function runIitScoring({ weekDate, regime = 'Neutral' } = {}) {
  if (!weekDate) throw new Error('weekDate is required (YYYY-MM-DD)');

  console.log(`[IIT] Starting scoring run — week: ${weekDate}, regime: ${regime}`);

  // ── 1. Universe ────────────────────────────────────────────────────────────
  const universe = await loadUniverse();
  console.log(`[IIT] Universe: ${universe.length} tickers`);

  const prowess   = new ProwessHelper(prisma);
  const finHelper = new FinHelper(prisma);
  await warmProwessCache(prowess, universe);

  const tickers = universe.map(u => u.company);

  // ── 2. Technical signals (single batch) ───────────────────────────────────
  const techMap = await computeTechnicals(tickers, weekDate);

  // ── 3. Valuation (single batch) ───────────────────────────────────────────
  const valMap = await computeValuation(tickers, weekDate);

  // ── 4. Fundamentals (per ticker, concurrency-limited) ─────────────────────
  const fundResults = await pMap(universe, async ({ company: ticker, basic_industry }) => {
    const bfsi = classification.hierarchy[basic_industry]?.economic_model === 'Financial';
    try {
      const metrics = await computeFundamentals(ticker, bfsi, prowess, finHelper);
      return { ticker, metrics };
    } catch (err) {
      console.error(`[IIT] fundamentals error for ${ticker}:`, err.message);
      return { ticker, metrics: null };
    }
  }, FUNDAMENTALS_CONCURRENCY);

  const fundMap = new Map(fundResults.map(({ ticker, metrics }) => [ticker, metrics]));

  // ── 5. Cross-sectional ranking ────────────────────────────────────────────
  const rankMaps = buildRankMaps(tickers, fundMap, techMap, valMap);

  // ── 6. Per-stock composite scores ─────────────────────────────────────────
  const stockScores = universe.map(({ company: ticker, basic_industry }) => {
    const entry         = classification.hierarchy[basic_industry] ?? {};
    const economicModel = entry.economic_model ?? 'Consumption';
    const techData      = techMap.get(ticker);

    const factorScores                     = buildFactorScores(ticker, rankMaps);
    const { composite_score, factor_weights } = computeComposite(factorScores, economicModel, regime);

    return {
      ticker,
      basic_industry,
      economic_model:  economicModel,
      composite_score,
      ...factorScores,
      _above_20w:      techData?.above_20w ?? null, // raw 0/1 for cluster breadth_pct
      factor_weights,
    };
  });

  // ── 7. Cluster scores ─────────────────────────────────────────────────────
  const clusterRaw    = computeClusterScores(stockScores);
  const clusterRanked = rankClusters(clusterRaw);
  const clusterFinal  = await attachWoWDeltas(clusterRanked, weekDate);

  // ── 8. Persist ────────────────────────────────────────────────────────────
  await saveStockScores(stockScores, weekDate, regime);
  await saveClusterScores(clusterFinal, weekDate, regime);

  console.log(`[IIT] Run complete — ${stockScores.length} stocks, ${clusterFinal.length} clusters`);

  return { stockScores, clusterScores: clusterFinal };
}

module.exports = { runIitScoring };
