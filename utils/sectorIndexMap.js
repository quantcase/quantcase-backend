'use strict';

/**
 * Stock → comparison-index resolver for the /technicals and /prices CRS legs.
 *
 * The watchlist sheet carries two classification columns per stock:
 *   - BASIC INDUSTRY         — the granular NSE basic-industry label
 *                              (e.g. "Private Sector Bank", "Specialty Chemicals")
 *   - MACRO ECONOMIC SECTOR  — one of NSE's 11 coarse macro buckets
 *                              (e.g. "Financial Services", "Commodities")
 *
 * NIFTY sector indices are defined at the *basic-industry* level, so the macro
 * bucket is too blunt to pick the right one — "Financial Services" lumps banks,
 * NBFCs, housing finance and insurance together; "Commodities" lumps metals,
 * cement and chemicals together. The old code keyed purely off the macro sector,
 * which is why e.g. a cement or a chemical stock both resolved to NIFTY METAL and
 * a private bank resolved to the broad NIFTY FINANCIAL SERVICE.
 *
 * Resolution is therefore tiered:
 *   1. BASIC INDUSTRY  → specific NIFTY sector index   (this map)
 *   2. MACRO SECTOR    → broad NIFTY sector index       (fallback)
 *   3. null            → no sector leg (better than a wrong one)
 *
 * ── Values ────────────────────────────────────────────────────────────────────
 * Every value is the index's *exact* Prowess/CMIE symbol as stored in the
 * `nse_equity_new` table (title-case, e.g. "Nifty Private Bank Index"). All of
 * them have been verified to exist as symbols in that table. Each index's CRS leg
 * only produces a value once that symbol's *daily history* is backfilled into
 * nse_equity_new — until then the leg is null, never an error (same contract as
 * lib/crs.js). Extend the maps as more basic industries / indices appear.
 */

// Broad-market benchmark — Prowess "Index Name" as stored in nse_equity_new.
const NIFTY_BENCHMARK_SYMBOL = 'Nifty 50';

// BASIC INDUSTRY (uppercased) → nse_equity_new NIFTY sector-index symbol.
// Only clear, defensible constituent matches are listed; anything not here falls
// through to the macro-sector map below rather than risk a wrong tight index.
const BASIC_INDUSTRY_INDEX_MAP = {
  // ── Banks & financials ──────────────────────────────────────────────────────
  'PRIVATE SECTOR BANK':                    'Nifty Private Bank Index',
  'PUBLIC SECTOR BANK':                     'Nifty Psu Bank',
  'OTHER BANK':                             'Nifty Bank',
  'HOUSING FINANCE COMPANY':                'Nifty Housing Index',
  'NBFC':                                   'Nifty Financial Services Ex-Bank Index',
  'MICROFINANCE INSTITUTIONS':              'Nifty Financial Services Ex-Bank Index',
  'LIFE INSURANCE':                         'Nifty Financial Services Ex-Bank Index',
  'GENERAL INSURANCE':                      'Nifty Financial Services Ex-Bank Index',
  'STOCKBROKING & ALLIED':                  'Nifty Capital Markets Index',
  'EXCHANGE AND DATA PLATFORM':             'Nifty Capital Markets Index',
  'DEP, CLRNG HOUSES AND OTHER INTERM':     'Nifty Capital Markets Index',
  'ASSET MANAGEMENT COMPANY':               'Nifty Capital Markets Index',
  'RATINGS':                                'Nifty Capital Markets Index',
  'OTHER CAPITAL MARKET RELATED SERVICES':  'Nifty Capital Markets Index',

  // ── Healthcare ──────────────────────────────────────────────────────────────
  'PHARMACEUTICALS':                        'Nifty Pharma',
  'BIOTECHNOLOGY':                          'Nifty Pharma',
  'HOSPITAL':                               'Nifty Healthcare Index',
  'HEALTHCARE SERVICE PROVIDER':            'Nifty Healthcare Index',
  'HEALTHCARE RESEARCH, ANALYTICS & TECHNOLOGY': 'Nifty Healthcare Index',
  'MEDICAL EQUIPMENT & SUPPLIES':           'Nifty Healthcare Index',
  'PHARMACY RETAIL':                        'Nifty Healthcare Index',

  // ── Information technology ──────────────────────────────────────────────────
  'COMPUTERS - SOFTWARE & CONSULTING':      'Nifty It',
  'IT ENABLED SERVICES':                    'Nifty It',
  'SOFTWARE PRODUCTS':                      'Nifty It',
  'COMPUTERS HARDWARE & EQUIPMENTS':        'Nifty It',

  // ── Chemicals ───────────────────────────────────────────────────────────────
  'SPECIALTY CHEMICALS':                    'Nifty Chemicals Index',
  'COMMODITY CHEMICALS':                    'Nifty Chemicals Index',
  'PESTICIDES & AGROCHEMICALS':             'Nifty Chemicals Index',
  'DYES AND PIGMENTS':                      'Nifty Chemicals Index',
  'INDUSTRIAL GASES':                       'Nifty Chemicals Index',
  'PRINTING INKS':                          'Nifty Chemicals Index',
  'CARBON BLACK':                           'Nifty Chemicals Index',
  'EXPLOSIVES':                             'Nifty Chemicals Index',
  'TRADING - CHEMICALS':                    'Nifty Chemicals Index',

  // ── Cement ──────────────────────────────────────────────────────────────────
  'CEMENT & CEMENT PRODUCTS':               'Nifty Cement Index',

  // ── Metals & mining ─────────────────────────────────────────────────────────
  'IRON & STEEL':                           'Nifty Metal',
  'IRON & STEEL PRODUCTS':                  'Nifty Metal',
  'SPONGE IRON':                            'Nifty Metal',
  'PIG IRON':                               'Nifty Metal',
  'FERRO & SILICA MANGANESE':               'Nifty Metal',
  'DIVERSIFIED METALS':                     'Nifty Metal',
  'ALUMINIUM':                              'Nifty Metal',
  'ALUMINIUM, COPPER & ZINC PRODUCTS':      'Nifty Metal',
  'COPPER':                                 'Nifty Metal',
  'ZINC':                                   'Nifty Metal',
  'PRECIOUS METALS':                        'Nifty Metal',
  'TRADING - METALS':                       'Nifty Metal',
  'TRADING - MINERALS':                     'Nifty Metal',
  'INDUSTRIAL MINERALS':                    'Nifty Metal',
  'COAL':                                   'Nifty Metal',

  // ── Oil & gas ───────────────────────────────────────────────────────────────
  'OIL EXPLORATION & PRODUCTION':           'Nifty Oil & Gas Index',
  'REFINERIES & MARKETING':                 'Nifty Oil & Gas Index',
  'OIL EQUIPMENT & SERVICES':               'Nifty Oil & Gas Index',
  'OFFSHORE SUPPORT SOLUTION DRILLING':     'Nifty Oil & Gas Index',
  'OIL STORAGE & TRANSPORTATION':           'Nifty Oil & Gas Index',
  'LUBRICANTS':                             'Nifty Oil & Gas Index',
  'LPG/CNG/PNG/LNG SUPPLIER':               'Nifty Oil & Gas Index',
  'GAS TRANSMISSION/MARKETING':             'Nifty Oil & Gas Index',
  'TRADING - GAS':                          'Nifty Oil & Gas Index',

  // ── Power / utilities ───────────────────────────────────────────────────────
  'POWER GENERATION':                       'Nifty Energy',
  'POWER DISTRIBUTION':                     'Nifty Energy',
  'INTEGRATED POWER UTILITIES':             'Nifty Energy',

  // ── Autos ───────────────────────────────────────────────────────────────────
  'AUTO COMPONENTS & EQUIPMENTS':           'Nifty Auto',
  'TYRES & RUBBER PRODUCTS':                'Nifty Auto',
  '2/3 WHEELERS':                           'Nifty Auto',
  'PASSENGER CARS & UTILITY VEHICLES':      'Nifty Auto',
  'COMMERCIAL VEHICLES':                    'Nifty Auto',
  'TRACTORS':                               'Nifty Auto',
  'TRADING - AUTO COMPONENTS':              'Nifty Auto',
  'AUTO DEALER':                            'Nifty Auto',

  // ── Consumer durables ───────────────────────────────────────────────────────
  'CONSUMER ELECTRONICS':                   'Nifty Consumer Durables Index',
  'HOUSEHOLD APPLIANCES':                   'Nifty Consumer Durables Index',
  'HOUSEWARE':                              'Nifty Consumer Durables Index',
  'FURNITURE, HOME FURNISHING':             'Nifty Consumer Durables Index',

  // ── FMCG ────────────────────────────────────────────────────────────────────
  'DIVERSIFIED FMCG':                       'Nifty Fmcg',
  'PACKAGED FOODS':                         'Nifty Fmcg',
  'PERSONAL CARE':                          'Nifty Fmcg',
  'DAIRY PRODUCTS':                         'Nifty Fmcg',
  'SUGAR':                                  'Nifty Fmcg',
  'BREWERIES & DISTILLERIES':               'Nifty Fmcg',
  'TEA & COFFEE':                           'Nifty Fmcg',
  'EDIBLE OIL':                             'Nifty Fmcg',
  'CIGARETTES & TOBACCO PRODUCTS':          'Nifty Fmcg',
  'HOUSEHOLD PRODUCTS':                     'Nifty Fmcg',

  // ── Media ───────────────────────────────────────────────────────────────────
  'TV BROADCASTING & SOFTWARE PRODUCTION':  'Nifty Media',
  'MEDIA & ENTERTAINMENT':                  'Nifty Media',
  'FILM PRODUCTION, DISTRIBUTION & EXHIBITION': 'Nifty Media',
  'ELECTRONIC MEDIA':                       'Nifty Media',
  'PRINT MEDIA':                            'Nifty Media',
  'PRINTING & PUBLICATION':                 'Nifty Media',
  'ADVERTISING & MEDIA AGENCIES':           'Nifty Media',
  'DIGITAL ENTERTAINMENT':                  'Nifty Media',

  // ── Realty & construction ───────────────────────────────────────────────────
  'RESIDENTIAL, COMMERCIAL PROJECTS':       'Nifty Realty',
  'REAL ESTATE RELATED SERVICES':           'Nifty Realty',
  'CIVIL CONSTRUCTION':                     'Nifty Infrastructure',
  'ROAD ASSETSTOLL, ANNUITY, HYBRID-ANNUITY': 'Nifty Infrastructure',

  // ── Defence ─────────────────────────────────────────────────────────────────
  'AEROSPACE & DEFENSE':                    'Nifty India Defence Index',
  'SHIP BUILDING & ALLIED SERVICES':        'Nifty India Defence Index',

  // ── Capital goods / electricals ─────────────────────────────────────────────
  'HEAVY ELECTRICAL EQUIPMENT':             'Nifty Capital Goods',
  'OTHER ELECTRICAL EQUIPMENT':             'Nifty Capital Goods',
  'CABLES - ELECTRICALS':                   'Nifty Capital Goods',
  'COMPRESSORS, PUMPS & DIESEL ENGINES':    'Nifty Capital Goods',
  'INDUSTRIAL PRODUCTS':                    'Nifty Capital Goods',
  'OTHER INDUSTRIAL PRODUCTS':              'Nifty Capital Goods',
  'CONSTRUCTION VEHICLES':                  'Nifty Capital Goods',

  // ── Transportation & logistics ──────────────────────────────────────────────
  'LOGISTICS SOLUTION PROVIDER':            'Nifty Transportation & Logistics Index',
  'SHIPPING':                               'Nifty Transportation & Logistics Index',
  'ROAD TRANSPORT':                         'Nifty Transportation & Logistics Index',
  'AIRLINE':                                'Nifty Transportation & Logistics Index',
  'PORT & PORT SERVICES':                   'Nifty Transportation & Logistics Index',
  'AIRPORT & AIRPORT SERVICES':             'Nifty Transportation & Logistics Index',
  'TRANSPORT RELATED SERVICES':             'Nifty Transportation & Logistics Index',
};

// MACRO ECONOMIC SECTOR (uppercased) → broad nse_equity_new NIFTY index.
// Fallback only, when the basic industry has no dedicated index above.
// Note: COMMODITIES now maps to the broad "Nifty Commodities" (spans metals,
// cement, chemicals, sugar, fertilizers) instead of the old NIFTY METAL, which
// wrongly forced every cement/chemical stock onto the metal index.
const MACRO_SECTOR_INDEX_MAP = {
  'INFORMATION TECHNOLOGY':             'Nifty It',
  'FINANCIAL SERVICES':                 'Nifty Financial Services',
  'FAST MOVING CONSUMER GOODS':         'Nifty Fmcg',
  'FMCG':                               'Nifty Fmcg',
  'HEALTHCARE':                         'Nifty Healthcare Index',
  'AUTOMOBILE AND AUTO COMPONENTS':     'Nifty Auto',
  'CONSUMER DURABLES':                  'Nifty Consumer Durables Index',
  'CONSUMER DISCRETIONARY':             'Nifty India Consumption',
  'OIL GAS & CONSUMABLE FUELS':         'Nifty Oil & Gas Index',
  'ENERGY':                             'Nifty Oil & Gas Index',
  'UTILITIES':                          'Nifty Energy',
  'MEDIA ENTERTAINMENT & PUBLICATION':  'Nifty Media',
  'MEDIA':                              'Nifty Media',
  'METALS & MINING':                    'Nifty Metal',
  'COMMODITIES':                        'Nifty Commodities',
  'INDUSTRIALS':                        'Nifty India Manufacturing Index',
  'SERVICES':                           'Nifty Services Sector',
  // TELECOMMUNICATION and DIVERSIFIED have no clean NIFTY sector index — omit so
  // they resolve to null (no sector leg) rather than a misleading one.
};

/** Uppercase, trim, and collapse internal whitespace so sheet labels match keys. */
function normalizeLabel(s) {
  return s ? String(s).toUpperCase().trim().replace(/\s+/g, ' ') : '';
}

/**
 * Resolve a stock's comparison NIFTY sector index (nse_equity_new symbol).
 * BASIC INDUSTRY wins; MACRO SECTOR is the fallback; null when neither maps.
 *
 * @param {{ basicIndustry?: string|null, macroSector?: string|null }} classification
 * @returns {string|null}
 */
function resolveIndexSymbol({ basicIndustry, macroSector } = {}) {
  const bi = normalizeLabel(basicIndustry);
  if (bi && BASIC_INDUSTRY_INDEX_MAP[bi]) return BASIC_INDUSTRY_INDEX_MAP[bi];
  const ms = normalizeLabel(macroSector);
  if (ms && MACRO_SECTOR_INDEX_MAP[ms]) return MACRO_SECTOR_INDEX_MAP[ms];
  return null;
}

module.exports = {
  NIFTY_BENCHMARK_SYMBOL,
  BASIC_INDUSTRY_INDEX_MAP,
  MACRO_SECTOR_INDEX_MAP,
  normalizeLabel,
  resolveIndexSymbol,
};
