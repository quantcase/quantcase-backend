'use strict';

/**
 * Shared holding resolver for the investor dashboard.
 *
 * Returns a unified holdings list for a user, preferring their smallcase-synced
 * broker holdings (full fidelity: quantity known, so current_value is an exact
 * qty × live-LTP market value) and falling back to their first-party CSV-uploaded
 * portfolio (ticker + amount_invested only; no share quantity, so current value is
 * approximated from live 1D enrichment).
 *
 * Both branches enrich from market data at read time. Neither the stored
 * SmallcaseHolding.current_value nor SmallcasePortfolio.total_value carries a
 * price — smallcase's holdings payload has none, so those columns sit at cost
 * basis and must not be used as market value.
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
    // The smallcase holdings payload carries no live price, so the stored
    // current_value / pnl are null and the stored portfolio totals fall back to
    // cost basis (total_value === total_invested). Enrich with live LTP here —
    // the same path GET /api/smallcase/holdings uses — so every dashboard
    // consumer sees true market value rather than what was paid.
    const scTickers  = [...new Set(scUser.holdings.map(h => h.ticker.toUpperCase()))];
    const marketData = await enrichHoldings(scTickers);

    const holdings = scUser.holdings.map(h => {
      const sym          = h.ticker.toUpperCase();
      const ltp          = marketData[sym]?.ltp ?? h.current_price ?? null;
      const invested     = h.invested_value ?? 0;
      // Quantity is authoritative for smallcase holdings, so qty × LTP is an exact
      // market value. Only fall back to the stored column when there is no price.
      const currentValue = (ltp != null && h.quantity != null) ? h.quantity * ltp : (h.current_value ?? null);
      const pnl          = currentValue != null ? currentValue - invested : null;
      const pnlPct       = pnl != null && invested > 0 ? (pnl / invested) * 100 : null;
      return {
        ticker:         sym,
        quantity:       h.quantity ?? null,
        invested_value: invested,
        current_value:  currentValue,
        pnl,
        pnl_pct:        pnlPct,
      };
    });

    // Recomputed from the enriched rows so the totals agree with them. The stored
    // portfolio row is deliberately not trusted: it is cost basis until a sync
    // lands prices, which would make equity_value read as invested_value.
    const totals = sumTotals(holdings);

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

// A holding with no live price (ETFs and recent listings are absent from
// nse_equity_new) contributes its cost basis, not nothing — dropping it would
// shrink current_value while invested_value still counts it, understating P&L by
// the whole position. Cost basis reads that holding as flat, which is the honest
// unknown. current_value stays null on the row so callers can still see which
// holdings lack a price.
function sumTotals(holdings) {
  let invested = 0;
  let current  = 0;
  let anyCurrent = false;
  for (const h of holdings) {
    invested += h.invested_value ?? 0;
    current  += h.current_value ?? h.invested_value ?? 0;
    if (h.current_value != null) anyCurrent = true;
  }
  return { current_value: anyCurrent ? current : null, invested_value: invested };
}

module.exports = { resolveHoldings };
