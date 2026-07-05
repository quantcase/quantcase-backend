'use strict';

// Default ticker set used by the L1 multi-dispatch flow when no explicit
// `tickers` list is supplied. Moved from scripts/analysis/analyze_L1_v2_multi_all.js
// so the CLI script, the admin route, and the scheduler handler share one list.
const DEFAULT_TARGET_TICKERS = [
  'NMDC', 'MOIL', 'GRAVITA',
  'BAJAJ-AUTO', 'TVSMOTOR', 'EICHERMOT',
  'ASIANPAINT', 'BERGEPAINT', 'KANSAINER',
  'RELIANCE', 'IOC', 'BPCL',
  'HATSUN', 'HERITGFOOD', 'PARAGMILK',
  'DABUR', 'GODREJCP', 'COLPAL',
  'HDFCAMC', 'NAM-INDIA', 'UTIAMC',
  'SBIN', 'BANKBARODA', 'CANBK',
  'BAJFINANCE', 'SHRIRAMFIN', 'CHOLAFIN',
  'APOLLOHOSP', 'MAXHEALTH', 'FORTIS',
  'HAL', 'BEL', 'BDL',
  'CUMMINSIND', 'KSB', 'KIRLOSBROS',
  'MAZDOCK', 'COCHINSHIP', 'SWANDEF',
  'TCS', 'INFY', 'HCLTECH',
  'SCI', 'GESHIP', 'TRANSWORLD',
  'BHARTIARTL', 'TATACOMM', 'TTML',
  'INDUSTOWER', 'HFCL', 'VINDHYATEL',
  'TATAPOWER', 'ADANIPOWER', 'TORNTPOWER',
  'WABAG', 'IONEXCHANG', 'JITFINFRA',
  'HDFCBANK', 'AXISBANK', 'IDBI',
  'INDIGOPNTS', 'MSUMI', 'IEX'
];

module.exports = { DEFAULT_TARGET_TICKERS };
