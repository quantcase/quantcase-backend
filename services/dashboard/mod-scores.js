'use strict';

/**
 * Bulk MOD (Management / Opportunity / Deal) pillar scores for a set of tickers.
 *
 * Reads the L3 `post_html_analysis` table (types management/opportunity/deal), pulling
 * the 0-100 `result.score` and `verdict_band` per ticker per pillar in a single
 * query — the same DISTINCT ON pattern used by enrichHoldings, avoiding an
 * N-query fan-out via getAnalysis().
 */

const prisma = require('../../config/prisma');

const PILLARS = ['management', 'opportunity', 'deal'];

/**
 * @param {string[]} tickers
 * @returns {Promise<Object>} map: { [SYMBOL]: { management: {score, verdict_band}|null, opportunity: ..., deal: ... } }
 */
async function fetchModScores(tickers) {
  if (!tickers.length) return {};
  const symbols = [...new Set(tickers.map(t => t.toUpperCase()))];

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (ticker, type) ticker, type,
           (result->>'score')::float   AS score,
           result->>'verdict_band'     AS verdict_band
    FROM post_html_analysis
    WHERE ticker = ANY(${symbols})
      AND layer_id = 'l3'
      AND type IN ('management', 'opportunity', 'deal')
    ORDER BY ticker, type, updated_at DESC NULLS LAST
  `;

  const map = {};
  for (const sym of symbols) {
    map[sym] = { management: null, opportunity: null, deal: null };
  }
  for (const row of rows) {
    const sym = row.ticker.toUpperCase();
    if (!map[sym]) map[sym] = { management: null, opportunity: null, deal: null };
    map[sym][row.type] = {
      score:        row.score != null ? Math.round(row.score) : null,
      verdict_band: row.verdict_band ?? null,
    };
  }
  return map;
}

module.exports = { fetchModScores, PILLARS };
