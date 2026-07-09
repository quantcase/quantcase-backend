'use strict';

/**
 * Shadow/tracker holdings resolver for the investor dashboard.
 *
 * Trackers are the user's shadow-portfolio holdings (from GET /api/portfolio/shadow).
 * They carry a ticker + live market_data but NO cost basis (amount_invested is 0
 * for every tracker), so downstream consumers must weight them equally rather than
 * by book value.
 *
 * Returned in the same UnifiedHolding shape resolveHoldings() produces so the
 * dashboard services can share their aggregation logic — except invested_value is
 * always 0 and current_value is derived from live price only when it can be.
 *
 * Consumed as the fallback source by mod-synopsis and holdings-summary when the
 * invested portfolio is empty.
 */

const prisma = require('../../config/prisma');
const { enrichHoldings } = require('../portfolio/market-data.service');

/**
 * @param {string} userId  req.user.sub
 * @returns {Promise<Array<{
 *   ticker: string,
 *   quantity: null,
 *   invested_value: 0,
 *   current_value: null,
 *   pnl: null,
 *   pnl_pct: number|null,
 *   market_data: object|null,
 * }>>}  empty array when the user has no shadow holdings
 */
async function resolveShadowHoldings(userId) {
  const portfolio = await prisma.shadowPortfolio.findUnique({
    where:   { user_id: userId },
    include: { holdings: true },
  });

  if (!portfolio || portfolio.holdings.length === 0) return [];

  const tickers    = [...new Set(portfolio.holdings.map(h => h.ticker.toUpperCase()))];
  const marketData = await enrichHoldings(tickers);

  return portfolio.holdings.map(h => {
    const sym    = h.ticker.toUpperCase();
    const md     = marketData[sym] ?? null;
    const chgPct = md?.change_percent ?? null;
    return {
      ticker:         sym,
      quantity:       null,
      invested_value: 0,          // trackers have no cost basis — never book-weight
      current_value:  null,       // no quantity and no invested amount → no market value
      pnl:            null,
      pnl_pct:        chgPct,
      market_data:    md,
    };
  });
}

/**
 * The shadow portfolio's updated_at, used as `synced_at` in the summary fallback.
 * @returns {Promise<Date|null>}
 */
async function getShadowSyncedAt(userId) {
  const portfolio = await prisma.shadowPortfolio.findUnique({
    where:  { user_id: userId },
    select: { updated_at: true },
  });
  return portfolio?.updated_at ?? null;
}

module.exports = { resolveShadowHoldings, getShadowSyncedAt };
