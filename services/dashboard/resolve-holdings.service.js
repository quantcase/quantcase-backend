'use strict';

/**
 * Shared holding resolver for the investor dashboard.
 *
 * Returns a unified holdings list for a user, preferring their smallcase-synced
 * broker holdings (full fidelity: quantity / current_value / invested_value / pnl)
 * and falling back to their first-party CSV-uploaded portfolio (ticker +
 * amount_invested only; no share quantity, so current value is approximated from
 * live 1D enrichment).
 *
 * Consumed by mod-synopsis and holdings-summary services.
 */

const prisma = require('../../config/prisma');
const { enrichHoldings } = require('../portfolio/market-data.service');

/**
 * @typedef {Object} UnifiedHolding
 * @property {string}      ticker
 * @property {number|null} quantity        null for first-party holdings
 * @property {number}      invested_value  cost basis (₹)
 * @property {number|null} current_value   market value (₹); null if unknown
 * @property {number|null} pnl
 * @property {number|null} pnl_pct
 */

/**
 * @param {string} userId  req.user.sub
 * @returns {Promise<{
 *   empty: boolean,
 *   source: 'smallcase'|'firstparty'|null,
 *   synced_at: (Date|string|null),
 *   totals: { current_value:number|null, invested_value:number },
 *   holdings: UnifiedHolding[],
 * }>}
 */
async function resolveHoldings(userId) {
  // ── 1. Prefer smallcase-synced holdings ────────────────────────────────────
  const scUser = await prisma.smallcaseUser.findUnique({
    where:   { user_id: userId },
    include: { holdings: true, portfolio: true },
  });

  if (scUser && scUser.is_connected && scUser.holdings.length > 0) {
    const holdings = scUser.holdings.map(h => ({
      ticker:         h.ticker.toUpperCase(),
      quantity:       h.quantity ?? null,
      invested_value: h.invested_value ?? 0,
      current_value:  h.current_value ?? null,
      pnl:            h.pnl ?? null,
      pnl_pct:        h.pnl_pct ?? null,
    }));

    const totals = scUser.portfolio
      ? { current_value: scUser.portfolio.total_value, invested_value: scUser.portfolio.total_invested }
      : sumTotals(holdings);

    return {
      empty:     false,
      source:    'smallcase',
      synced_at: scUser.portfolio?.synced_at ?? scUser.last_synced_at ?? null,
      totals,
      holdings,
    };
  }

  // ── 2. Fall back to first-party portfolio ──────────────────────────────────
  const portfolio = await prisma.userPortfolio.findUnique({
    where:   { user_id: userId },
    include: { holdings: true },
  });

  if (!portfolio || portfolio.holdings.length === 0) {
    return { empty: true, source: null, synced_at: null, totals: { current_value: null, invested_value: 0 }, holdings: [] };
  }

  // First-party holdings carry no share quantity — invested amount is the cost
  // basis. Grow it by today's move only (from enrichment) as a best-effort
  // current value; there is no true market value without quantity.
  const tickers    = [...new Set(portfolio.holdings.map(h => h.ticker.toUpperCase()))];
  const marketData = await enrichHoldings(tickers);

  const holdings = portfolio.holdings.map(h => {
    const sym    = h.ticker.toUpperCase();
    const md     = marketData[sym] ?? null;
    const chgPct = md?.change_percent ?? null;
    // Best-effort: apply today's % move to the cost basis so the value isn't flat.
    const current = chgPct != null ? h.amount_invested * (1 + chgPct / 100) : h.amount_invested;
    return {
      ticker:         sym,
      quantity:       null,
      invested_value: h.amount_invested,
      current_value:  current,
      pnl:            current != null ? current - h.amount_invested : null,
      pnl_pct:        chgPct,
    };
  });

  return {
    empty:     false,
    source:    'firstparty',
    synced_at: portfolio.updated_at ?? null,
    totals:    sumTotals(holdings),
    holdings,
  };
}

function sumTotals(holdings) {
  let invested = 0;
  let current  = 0;
  let anyCurrent = false;
  for (const h of holdings) {
    invested += h.invested_value ?? 0;
    if (h.current_value != null) { current += h.current_value; anyCurrent = true; }
  }
  return { current_value: anyCurrent ? current : null, invested_value: invested };
}

module.exports = { resolveHoldings };
