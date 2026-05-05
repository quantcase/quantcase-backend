'use strict';

const prisma = require('../../config/prisma');
const { avg }  = require('./scoring');

const MIN_CLUSTER_SZ = 3;

function median(sortedAsc) {
  if (!sortedAsc.length) return null;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2
    ? sortedAsc[mid]
    : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Aggregate per-stock scores into cluster-level composites.
 * cluster_composite = 0.65 × median(stock composites) + 0.35 × breadth_pct
 *
 * @param {Array} stockScores  — output rows from the stock-scoring step
 * @returns {Array}
 */
function computeClusterScores(stockScores) {
  const byCluster = new Map();
  for (const s of stockScores) {
    if (!byCluster.has(s.basic_industry)) byCluster.set(s.basic_industry, []);
    byCluster.get(s.basic_industry).push(s);
  }

  return [...byCluster.entries()].map(([cluster, stocks]) => {
    const composites    = stocks.map(s => s.composite_score).filter(v => v != null).sort((a, b) => a - b);
    const priceStocks   = stocks.filter(s => s._above_20w != null);
    const breadthPct    = priceStocks.length
      ? (priceStocks.filter(s => s._above_20w === 1).length / priceStocks.length) * 100
      : null;
    const medianScore   = median(composites);

    let composite_score = null;
    if (medianScore != null && breadthPct != null) {
      composite_score = Math.round((0.65 * medianScore + 0.35 * breadthPct) * 10) / 10;
    } else if (medianScore != null) {
      composite_score = Math.round(medianScore * 10) / 10;
    }

    const momentumScores = stocks.map(s => s.momentum_score).filter(v => v != null).sort((a, b) => a - b);

    return {
      basic_industry:    cluster,
      median_score:      medianScore != null ? Math.round(medianScore * 10) / 10 : null,
      breadth_pct:       breadthPct  != null ? Math.round(breadthPct  * 10) / 10 : null,
      composite_score,
      _momentum_median:  median(momentumScores), // tie-breaker, not persisted
      stock_count:       stocks.length,
      scored_stock_count: composites.length,
      low_confidence:    composites.length < MIN_CLUSTER_SZ,
    };
  });
}

/**
 * Sort clusters by composite score, assign rank 1..N (ties broken by median momentum).
 * Clusters below MIN_CLUSTER_SZ get rank = null.
 */
function rankClusters(clusters) {
  const rankable = clusters
    .filter(c => c.composite_score != null && !c.low_confidence)
    .sort((a, b) => {
      const diff = b.composite_score - a.composite_score;
      return Math.abs(diff) > 0.001 ? diff : (b._momentum_median ?? 0) - (a._momentum_median ?? 0);
    });

  const n = rankable.length;
  rankable.forEach((c, i) => {
    c.rank     = i + 1;
    const pct  = c.rank / n;
    c.quartile = pct <= 0.25 ? 'Q1' : pct <= 0.5 ? 'Q2' : pct <= 0.75 ? 'Q3' : 'Q4';
  });

  const unranked = clusters.filter(c => c.composite_score == null || c.low_confidence);
  unranked.forEach(c => { c.rank = null; c.quartile = null; });

  return [...rankable, ...unranked];
}

/**
 * Look up the previous week's cluster scores and attach WoW / velocity deltas.
 *
 * @param {Array}  clusters
 * @param {string} weekDate  'YYYY-MM-DD'
 */
async function attachWoWDeltas(clusters, weekDate) {
  const clusterNames   = clusters.map(c => c.basic_industry);
  const prevCutoff     = new Date(new Date(weekDate).getTime() - 7  * 24 * 60 * 60 * 1000);
  const olderCutoff    = new Date(new Date(weekDate).getTime() - 21 * 24 * 60 * 60 * 1000);

  const [prevRows, olderRows] = await Promise.all([
    prisma.iitClusterScore.findMany({
      where:   { basic_industry: { in: clusterNames }, week_date: { lte: prevCutoff } },
      orderBy: { week_date: 'desc' },
    }),
    prisma.iitClusterScore.findMany({
      where:   { basic_industry: { in: clusterNames }, week_date: { lte: olderCutoff } },
      orderBy: { week_date: 'desc' },
    }),
  ]);

  const latest = (rows) => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.basic_industry)) m.set(r.basic_industry, r); }
    return m;
  };

  const prevMap  = latest(prevRows);
  const olderMap = latest(olderRows);

  return clusters.map(c => {
    const prev  = prevMap.get(c.basic_industry);
    const older = olderMap.get(c.basic_industry);

    const rank_prev       = prev?.rank ?? null;
    const wow_delta       = c.rank != null && rank_prev != null ? rank_prev - c.rank : null;
    const velocity_3w     = c.rank != null && older?.rank != null ? older.rank - c.rank : null;
    const score_wow_delta = c.composite_score != null && prev?.composite_score != null
      ? Math.round((c.composite_score - parseFloat(prev.composite_score)) * 10) / 10
      : null;

    let rank_trend = null;
    if (prev?.rank != null && older?.rank != null && c.rank != null) {
      const arrow = (from, to) => from > to ? '↑' : from < to ? '↓' : '→';
      rank_trend = `${arrow(older.rank, prev.rank)} ${arrow(prev.rank, c.rank)}`;
    }

    return { ...c, rank_prev, wow_delta, velocity_3w, score_wow_delta, rank_trend };
  });
}

module.exports = { computeClusterScores, rankClusters, attachWoWDeltas };
