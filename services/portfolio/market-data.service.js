'use strict';

const prisma = require('../../config/prisma');

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
 * - ltp / change / change_percent : latest close + 1D move from nse_equity
 * - qc_score                      : composite_score from iit_weekly_stock_scores (latest week)
 * - conviction                    : POSITIVE | NEUTRAL | WATCH — derived from ai_insights verdict_band
 * - thesis_tags                   : which of MANAGEMENT | OPPORTUNITY | DEAL have an ai_insights row
 */
async function enrichHoldings(tickers) {
  if (!tickers.length) return {};

  const symbols = tickers.map(t => t.toUpperCase());

  const [priceRows, scoreRows, insightRows] = await Promise.all([
    // Latest 2 closes per symbol to compute LTP + 1D change
    prisma.$queryRaw`
      SELECT symbol, close, datetime
      FROM (
        SELECT symbol, close, datetime,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY datetime DESC) AS rn
        FROM nse_equity
        WHERE symbol = ANY(${symbols}) AND close IS NOT NULL
      ) sub
      WHERE rn <= 2
      ORDER BY symbol, rn
    `,

    // Latest week IIT composite score per ticker
    prisma.$queryRaw`
      SELECT DISTINCT ON (ticker) ticker, composite_score, week_date
      FROM iit_weekly_stock_scores
      WHERE ticker = ANY(${symbols})
      ORDER BY ticker, week_date DESC
    `,

    // All ai_insights rows for these tickers (management / opportunity / deal)
    prisma.aiInsight.findMany({
      where: {
        ticker: { in: symbols },
        type:   { in: ['management', 'opportunity', 'deal'] },
      },
      select: { ticker: true, type: true, insight: true },
    }),
  ]);

  // Build per-symbol price map: symbol → [row1 (latest), row2 (prev)]
  const priceMap = {};
  for (const row of priceRows) {
    const sym = row.symbol.toUpperCase();
    if (!priceMap[sym]) priceMap[sym] = [];
    priceMap[sym].push(row);
  }

  // IIT score map
  const scoreMap = {};
  for (const row of scoreRows) {
    scoreMap[row.ticker.toUpperCase()] = row.composite_score != null ? parseFloat(row.composite_score) : null;
  }

  // ai_insights map: symbol → { management?, opportunity?, deal? }
  const insightMap = {};
  for (const row of insightRows) {
    const sym = row.ticker.toUpperCase();
    if (!insightMap[sym]) insightMap[sym] = {};
    insightMap[sym][row.type] = row.insight;
  }

  const result = {};
  for (const sym of symbols) {
    const prices     = priceMap[sym] || [];
    const latest     = prices[0];
    const prev       = prices[1];
    const ltp        = latest?.close != null ? parseFloat(latest.close) : null;
    const prevClose  = prev?.close   != null ? parseFloat(prev.close)   : null;

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
