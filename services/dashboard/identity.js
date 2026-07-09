'use strict';

/**
 * Symbol-indexed identity lookups for the investor dashboard.
 *
 * Builds a one-time map from NSE symbol → { companyName, industryGroup,
 * basicIndustry, capLabel } off lib/osc_identity.csv, reusing the parser in
 * lib/peerIdentity.js. Cheap per-symbol lookups for cap-segment / industry-segment
 * bucketing and holding names.
 */

const { load, COL_NAME, COL_INDUSTRY_GRP, COL_NSE_BASIC_IND, COL_NSE_SYMBOL } = require('../../lib/peerIdentity');

// osc_identity.csv column indices not already exported by peerIdentity.js.
const COL_AMFI_CATEGORY = 20; // "Large Cap" | "Mid Cap" | "Small Cap"

let _bySymbol = null;

function buildIndex() {
  if (_bySymbol) return _bySymbol;
  const { rows } = load();
  _bySymbol = new Map();
  for (const row of rows) {
    const sym = (row[COL_NSE_SYMBOL] || '').trim().toUpperCase();
    if (!sym) continue;
    _bySymbol.set(sym, {
      companyName:   (row[COL_NAME]           || '').trim() || null,
      industryGroup: (row[COL_INDUSTRY_GRP]   || '').trim() || null,
      basicIndustry: (row[COL_NSE_BASIC_IND]  || '').trim() || null,
      capLabel:      (row[COL_AMFI_CATEGORY]  || '').trim() || null,
    });
  }
  return _bySymbol;
}

/**
 * @param {string} symbol NSE symbol
 * @returns {{ companyName, industryGroup, basicIndustry, capLabel }|null}
 */
function lookup(symbol) {
  if (!symbol) return null;
  return buildIndex().get(symbol.trim().toUpperCase()) ?? null;
}

module.exports = { lookup };
