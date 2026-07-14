'use strict';

/**
 * GET /api/market/indices
 *
 * NIFTY / SENSEX header ticker. Shared across users (not user-scoped) and lightly
 * cached in-memory.
 *
 * Live since indices are now ingested into nse_equity_new (admin CSV upload,
 * mode "index" — see services/prowessHistoric.service.js). Indices share the
 * same table/PK as stocks; `symbol` there is the index's Prowess name verbatim
 * (verified: "Nifty 50", "Bse Sensex" — title-cased, not the short codes the
 * frontend expects), mapped below to NIFTY/SENSEX.
 */

const prisma = require('../../config/prisma');

const CACHE_TTL_MS = 45 * 1000;

// DB symbol (Prowess's own "Index Name" casing) → frontend-facing short code.
const INDEX_SYMBOL_MAP = {
  'Nifty 50':   'NIFTY',
  'Bse Sensex': 'SENSEX',
};

let _cache = null; // { at: epochMs, payload }

async function computeIndices() {
  const dbSymbols = Object.keys(INDEX_SYMBOL_MAP);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (symbol) symbol, close, pct_change, datetime
    FROM nse_equity_new
    WHERE symbol = ANY($1)
    ORDER BY symbol, datetime DESC
  `, dbSymbols);

  return rows.map((r) => ({
    symbol: INDEX_SYMBOL_MAP[r.symbol],
    value: r.close,
    // CMIE's "Daily Index Returns" — vs. the prior trading day's close, not this
    // row's own open→close. Stored as a raw fraction (0.0042 = 0.42%) — convert
    // to percentage points.
    change_pct: r.pct_change != null ? Number((r.pct_change * 100).toFixed(2)) : null,
  }));
}

async function getMarketIndices() {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) {
    return _cache.payload;
  }

  const indices = await computeIndices();
  const payload = { indices, as_of: new Date(now).toISOString() };
  _cache = { at: now, payload };
  return payload;
}

module.exports = { getMarketIndices };
