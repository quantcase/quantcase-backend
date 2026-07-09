'use strict';

/**
 * GET /api/portfolio/mod-synopsis
 *
 * Book-weighted Management / Opportunity / Deal score for the user's whole
 * equity book, plus the names dragging the weakest pillar and a per-holding
 * breakdown for the drawer.
 */

const { resolveHoldings } = require('./resolve-holdings.service');
const { resolveShadowHoldings } = require('./resolve-shadow-holdings.service');
const { fetchModScores, PILLARS } = require('./mod-scores');
const identity = require('./identity');

/** Map a 0-100 score → rating band (thresholds from the spec). */
function ratingFor(score) {
  if (score == null)  return 'WEAK';
  if (score >= 75)    return 'STRONG';
  if (score >= 60)    return 'FAIR';
  if (score >= 45)    return 'STRETCHED';
  return 'WEAK';
}

const EMPTY = {
  empty:           true,
  holdings_type:   'holdings',
  overall_score:   0,
  sub_scores:      PILLARS.map(p => ({ pillar: p, score: 0, rating: 'WEAK' })),
  weakest_pillar:  null,
  dragging_symbols: [],
  breakdown:       [],
};

async function getModSynopsis(userId) {
  const { empty, holdings } = await resolveHoldings(userId);

  // Invested portfolio has holdings → real book, book-weighted.
  if (!empty && holdings.length > 0) {
    return buildSynopsis(holdings, { holdingsType: 'holdings' });
  }

  // Invested portfolio empty → fall back to shadow/tracker holdings (equal-weighted).
  const trackers = await resolveShadowHoldings(userId);
  if (trackers.length === 0) return EMPTY;

  return buildSynopsis(trackers, { holdingsType: 'trackers' });
}

/**
 * Build the synopsis from a unified holdings list.
 *
 * For 'holdings' (real book) each holding is weighted by cost basis. For
 * 'trackers' (shadow) amount_invested is 0 for all rows, so we weight equally —
 * a simple mean across trackers.
 */
async function buildSynopsis(holdings, { holdingsType }) {
  const equalWeighted = holdingsType === 'trackers';

  const tickers   = holdings.map(h => h.ticker);
  const scoreMap  = await fetchModScores(tickers);

  // Book weight per holding: cost basis for a real book, equal share for trackers.
  const n = holdings.length;
  const totalInvested = holdings.reduce((s, h) => s + (h.invested_value || 0), 0) || 1;
  const weightOf = h => (equalWeighted ? 1 : (h.invested_value || 0));

  // Build per-holding breakdown rows.
  const breakdown = holdings.map(h => {
    const sc   = scoreMap[h.ticker] ?? {};
    const info = identity.lookup(h.ticker);
    return {
      symbol:      h.ticker,
      name:        info?.companyName ?? h.ticker,
      weight_pct:  equalWeighted
        ? round1(100 / n)
        : round1((h.invested_value || 0) / totalInvested * 100),
      management:  sc.management?.score ?? null,
      opportunity: sc.opportunity?.score ?? null,
      deal:        sc.deal?.score ?? null,
    };
  });

  // Weighted sub-score per pillar (ignore holdings with no score for that pillar).
  const sub_scores = PILLARS.map(pillar => {
    let weighted = 0;
    let weight   = 0;
    for (const h of holdings) {
      const s = scoreMap[h.ticker]?.[pillar]?.score;
      if (s == null) continue;
      const w = weightOf(h);
      weighted += s * w;
      weight   += w;
    }
    const score = weight > 0 ? Math.round(weighted / weight) : 0;
    return { pillar, score, rating: ratingFor(score) };
  });

  const overall_score = Math.round(
    sub_scores.reduce((s, p) => s + p.score, 0) / sub_scores.length
  );

  // Weakest pillar + the holdings dragging it (lowest scores in that pillar).
  const weakest = sub_scores.reduce((min, p) => (p.score < min.score ? p : min), sub_scores[0]);
  const dragging_symbols = holdings
    .map(h => ({ symbol: h.ticker, score: scoreMap[h.ticker]?.[weakest.pillar]?.score }))
    .filter(x => x.score != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map(x => x.symbol);

  return {
    empty:            false,
    holdings_type:    holdingsType,
    overall_score,
    sub_scores,
    weakest_pillar:   weakest.pillar,
    dragging_symbols,
    breakdown,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }

module.exports = { getModSynopsis };
