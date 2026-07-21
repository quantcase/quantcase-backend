'use strict';

/**
 * Comparative Relative Strength (CRS) daily series for the price chart.
 *
 * Produces three time-series arrays — same {date, value} shape as sma20/rsi14 —
 * consumed by GET /api/screener/:symbol/prices inside its `indicators` object:
 *
 *   crsStockVsNifty   — the stock vs NIFTY 50
 *   crsStockVsSector  — the stock vs its NIFTY sector index
 *   crsSectorVsNifty  — that sector index vs NIFTY 50
 *
 * Each value is a *rebased* comparative-strength ratio:
 *
 *     value[i] = (A[i] / A_base) / (B[i] / B_base)
 *
 * where `base` is the first date in the window at which both legs have a close.
 * It starts at 1.0 and drifts above 1.0 when A outperforms B since the base,
 * below when it lags — i.e. cumulative relative performance over the visible
 * window (the ~1.0 scale the frontend expects, e.g. 1.02 / 0.98 / 1.05).
 *
 * ── Data source ──────────────────────────────────────────────────────────────
 * ALL index history is read from `nse_equity_new` by symbol — the same table and
 * naming convention the market-indices header uses (see
 * services/dashboard/market-indices.service.js). Index rows there carry Prowess's
 * own title-case names ("Nifty 50", "Nifty It", ...). This is deliberately the
 * only source: as each index symbol's daily history is backfilled into that table,
 * the corresponding CRS leg starts returning values with no code change. Until a
 * given index is populated, its legs are simply null — never an error.
 */

const prisma = require('../config/prisma');
const technicalAnalysis = require('./technicalAnalysis');

// Broad-market benchmark — Prowess/CMIE "Index Name" as stored in nse_equity_new.
const NIFTY_EQUITY_SYMBOL = 'Nifty 50';

/**
 * Watchlist macro-economic sector (verbatim sheet labels, uppercased) → the NIFTY
 * sector index's symbol in nse_equity_new. Keys mirror the proven set in
 * technicalAnalysis._fetchCRSData so /prices CRS selects the same sector index the
 * /technicals leadership table does; values are the nse_equity_new symbols verified
 * to exist in that table. Extend as more sectors/labels appear.
 */
const SECTOR_EQUITY_INDEX_MAP = {
  'INFORMATION TECHNOLOGY':          'Nifty It',
  'FINANCIAL SERVICES':              'Nifty Financial Services',
  'FAST MOVING CONSUMER GOODS':      'Nifty Fmcg',
  'FMCG':                            'Nifty Fmcg',
  'HEALTHCARE':                      'Nifty Healthcare Index',
  'AUTOMOBILE AND AUTO COMPONENTS':  'Nifty Auto',
  'CONSUMER DURABLES':               'Nifty Consumer Durables Index',
  'OIL GAS & CONSUMABLE FUELS':      'Nifty Oil & Gas Index',
  'ENERGY':                          'Nifty Oil & Gas Index',
  'MEDIA ENTERTAINMENT & PUBLICATION': 'Nifty Media',
  'MEDIA':                           'Nifty Media',
  'METALS & MINING':                 'Nifty Metal',
  'COMMODITIES':                     'Nifty Metal',
  'SERVICES':                        'Nifty Services Sector',
};

function r4(v) {
  return v == null || Number.isNaN(v) ? null : Math.round(v * 10000) / 10000;
}

/** Map a watchlist macro-sector label to its nse_equity_new sector index symbol, or null. */
function resolveSectorSymbol(macroSector) {
  if (!macroSector) return null;
  return SECTOR_EQUITY_INDEX_MAP[macroSector.toUpperCase().trim()] ?? null;
}

/**
 * Build one rebased CRS line aligned 1:1 with `dateAxis` (the stock's price dates).
 *
 * @param {string[]} dateAxis            ordered YYYY-MM-DD price dates
 * @param {Map<string,number>} aByDate   leg A closes keyed by date
 * @param {Map<string,number>} bByDate   leg B closes keyed by date
 * @returns {Array<{date:string, value:number|null}>}  same length as dateAxis;
 *          value is null before the base date and on any date either leg is missing.
 */
function crsLine(dateAxis, aByDate, bByDate) {
  const out = dateAxis.map((date) => ({ date, value: null }));
  let aBase = null, bBase = null;
  for (let i = 0; i < dateAxis.length; i++) {
    const a = aByDate.get(dateAxis[i]);
    const b = bByDate.get(dateAxis[i]);
    if (a == null || b == null || a === 0 || b === 0) continue;
    if (aBase == null) { aBase = a; bBase = b; } // fix the rebase point at first common date
    out[i].value = r4((a / aBase) / (b / bBase));
  }
  return out;
}

/** Fetch an index's daily closes from nse_equity_new over [from, to] as a date→close Map. */
async function fetchIndexCloses(symbol, from, to) {
  const rows = await prisma.nse_equity_new.findMany({
    where:   { symbol, datetime: { gte: from, lte: to } },
    orderBy: { datetime: 'asc' },
    select:  { datetime: true, close: true },
  });
  const byDate = new Map();
  for (const r of rows) {
    if (r.close != null) byDate.set(r.datetime.toISOString().slice(0, 10), r.close);
  }
  return byDate;
}

/**
 * Compute the three CRS series for a symbol over a price window.
 *
 * @param {string} symbol                        uppercased NSE symbol
 * @param {Array<{date:string, close:number}>} priceBars  the endpoint's `prices` (close != null)
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<{crsStockVsNifty:Array, crsStockVsSector:Array, crsSectorVsNifty:Array}>}
 *          Each array is aligned to priceBars' dates; legs with no index data yet are all-null.
 */
async function computeCrsSeries(symbol, priceBars, from, to) {
  const dateAxis = priceBars.map((b) => b.date);
  const stockByDate = new Map(priceBars.map((b) => [b.date, b.close]));

  // Sector resolution and the index reads are independent — fan them out together.
  const macroSector  = await technicalAnalysis.resolveMacroSector(symbol).catch(() => null);
  const sectorSymbol = resolveSectorSymbol(macroSector);

  const [niftyByDate, sectorByDate] = await Promise.all([
    fetchIndexCloses(NIFTY_EQUITY_SYMBOL, from, to),
    sectorSymbol ? fetchIndexCloses(sectorSymbol, from, to) : Promise.resolve(new Map()),
  ]);

  return {
    crsStockVsNifty:  crsLine(dateAxis, stockByDate,  niftyByDate),
    crsStockVsSector: crsLine(dateAxis, stockByDate,  sectorByDate),
    crsSectorVsNifty: crsLine(dateAxis, sectorByDate, niftyByDate),
  };
}

module.exports = {
  computeCrsSeries,
  crsLine,
  resolveSectorSymbol,
  fetchIndexCloses,
  NIFTY_EQUITY_SYMBOL,
  SECTOR_EQUITY_INDEX_MAP,
};
