'use strict';

/**
 * Maps NSE tickers → Prowess company name + basic_industry.
 * Used to query prowess_values_new by company name.
 *
 * Add entries here as needed. Prowess company names must match exactly
 * the `company` column in prowess_values_new.
 */
const TICKER_MAP = {
  MSUMI: {
    prowessName:    'Motherson Sumi Wiring India Ltd.',
    basic_industry: 'Auto Components & Equipments',
  },
};

/**
 * @param {string} ticker  NSE ticker, e.g. 'MSUMI'
 * @returns {{ prowessName: string, basic_industry: string } | null}
 */
function resolveProwess(ticker) {
  return TICKER_MAP[ticker] ?? null;
}

module.exports = { resolveProwess };
