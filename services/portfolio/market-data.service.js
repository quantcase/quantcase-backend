'use strict';

const prisma = require('../../config/prisma');
const { fetchMarketSnapshots } = require('../../utils/formulaRegistry/dataFetcherMarket');

const CONVICTION_MAP = {
  'STRONG BUY':    'POSITIVE',
  'MODERATE BAND': 'POSITIVE',
  'CAUTIOUS HOLD': 'NEUTRAL',
  'WEAK / AVOID':  'WATCH',
};

/**
 * Bulk-fetch market enrichment for a list of tickers.
 * Returns a map: { [TICKER]: { ltp, change, change_percent, qc_score, conviction, thesis_tags } }
 *
 * - ltp / change / change_percent : latest close + 1D move from nse_equity_new
 * - qc_score                      : composite_score from iit_weekly_stock_scores (latest week)
 * - conviction                    : POSITIVE | NEUTRAL | WATCH — derived from ai_insights verdict_band
 * - thesis_tags                   : which of MANAGEMENT | OPPORTUNITY | DEAL have an ai_insights row
 */
async function enrichHoldings(tickers) {
  if (!tickers.length) return {};

  const symbols = tickers.map(t => t.toUpperCase());

  const [priceSnaps, scoreRows, insightRows] = await Promise.all([
    fetchMarketSnapshots(prisma, symbols),

    // Latest week IIT composite score per ticker
    prisma.$queryRaw`
      SELECT DISTINCT ON (ticker) ticker, composite_score, week_date
      FROM iit_weekly_stock_scores
      WHERE ticker = ANY(${symbols})
      ORDER BY ticker, week_date DESC
    `,

    // Latest ai_insights verdict_band per ticker (management / opportunity / deal)
    prisma.$queryRaw`
      SELECT DISTINCT ON (ticker, type) ticker, type,
             insight->>'verdict_band' AS verdict_band
      FROM ai_insights
      WHERE ticker = ANY(${symbols})
        AND type IN ('management', 'opportunity', 'deal')
      ORDER BY ticker, type, updated_at DESC NULLS LAST
    `,
  ]);

  // IIT score map
  const scoreMap = {};
  for (const row of scoreRows) {
    scoreMap[row.ticker.toUpperCase()] = row.composite_score != null ? parseFloat(row.composite_score) : null;
  }

  // ai_insights map: symbol → { management?, opportunity?, deal? } with just verdict_band
  const insightMap = {};
  for (const row of insightRows) {
    const sym = row.ticker.toUpperCase();
    if (!insightMap[sym]) insightMap[sym] = {};
    insightMap[sym][row.type] = { verdict_band: row.verdict_band ?? null };
  }

  const result = {};
  for (const sym of symbols) {
    const snap       = priceSnaps[sym] ?? null;
    const ltp        = snap?.close     ?? null;
    const prevClose  = snap?.prevClose ?? null;

    const change         = ltp != null && prevClose != null ? Math.round((ltp - prevClose) * 100) / 100 : null;
    const change_percent = ltp != null && prevClose != null && prevClose !== 0
      ? Math.round(((ltp - prevClose) / prevClose) * 10000) / 100
      : null;

    const qc_score = scoreMap[sym] ?? null;

    // Derive conviction from the best available insight (prefer management > opportunity > deal)
    const insights = insightMap[sym] ?? {};
    const bestInsight = insights.management ?? insights.opportunity ?? insights.deal ?? null;
    const verdictBand = bestInsight?.verdict_band ?? null;
    const conviction  = verdictBand ? (CONVICTION_MAP[verdictBand] ?? 'NEUTRAL') : null;

    // thesis_tags: which types are available
    const thesis_tags = ['MANAGEMENT', 'OPPORTUNITY', 'DEAL'].filter(
      t => insights[t.toLowerCase()] != null
    );

    result[sym] = { ltp, change, change_percent, qc_score, conviction, thesis_tags };
  }

  return result;
}

module.exports = { enrichHoldings };
