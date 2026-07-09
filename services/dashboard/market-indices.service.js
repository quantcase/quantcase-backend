'use strict';

/**
 * GET /api/market/indices
 *
 * NIFTY / SENSEX header ticker. Shared across users (not user-scoped) and lightly
 * cached in-memory.
 *
 * There is no live NIFTY/SENSEX feed wired yet (the nse_index table is sector-keyed
 * OHLCV and does not contain broad-index rows). These are static placeholder values
 * so the header renders; the service is structured so a real source can drop in
 * behind `computeIndices()` without changing the controller. See delivery notes.
 */

const CACHE_TTL_MS = 45 * 1000;

// Placeholder values — replace with a live source (external API or nse_index
// once broad-index rows are ingested).
const STATIC_INDICES = [
  { symbol: 'NIFTY',  value: 24318, change_pct: 0.42 },
  { symbol: 'SENSEX', value: 79712, change_pct: 0.38 },
];

let _cache = null; // { at: epochMs, payload }

async function computeIndices() {
  // TODO: swap for a live fetch. Returns the same shape as STATIC_INDICES.
  return STATIC_INDICES;
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
