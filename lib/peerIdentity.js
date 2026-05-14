'use strict';

const fs       = require('fs');
const path     = require('path');
const csvParse = require('csv-parse/sync');

// Column indices in osc_identity.csv (0-based)
const COL_NAME          = 0;
const COL_INDUSTRY_GRP  = 9;
const COL_NSE_BASIC_IND = 24;
const COL_NSE_SYMBOL    = 25;
const COL_DESCRIPTION   = 8;
const COL_OWNERSHIP_GRP = 17;
const COL_MAIN_PRODUCT  = 12;
const COL_MACRO_SECTOR  = 10; // "Macro sector"

let _rows   = null;
let _header = null;

function load() {
  if (_rows) return { rows: _rows, header: _header };
  const raw     = fs.readFileSync(path.join(__dirname, 'osc_identity.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all     = csvParse.parse(content, { relax_column_count: true });
  _header = all[0];
  _rows   = all.slice(1);
  return { rows: _rows, header: _header };
}

/**
 * Look up identity fields for a given NSE symbol.
 * Returns null if the symbol is not found.
 *
 * @param {string} symbol  e.g. "MSUMI"
 * @returns {{
 *   companyName: string|null,
 *   industryGroup: string|null,
 *   basicIndustry: string|null,
 *   macroSector: string|null,
 *   description: string|null,
 *   ownershipGroup: string|null,
 *   mainProduct: string|null,
 * }|null}
 */
function getIdentity(symbol) {
  const { rows } = load();
  const sym = symbol.trim().toUpperCase();
  const row = rows.find(r => (r[COL_NSE_SYMBOL] || '').trim().toUpperCase() === sym);
  if (!row) return null;
  return {
    companyName:   (row[COL_NAME]          || '').trim() || null,
    industryGroup: (row[COL_INDUSTRY_GRP]  || '').trim() || null,
    basicIndustry: (row[COL_NSE_BASIC_IND] || '').trim() || null,
    macroSector:   (row[COL_MACRO_SECTOR]  || '').trim() || null,
    description:   (row[COL_DESCRIPTION]   || '').trim() || null,
    ownershipGroup:(row[COL_OWNERSHIP_GRP] || '').trim() || null,
    mainProduct:   (row[COL_MAIN_PRODUCT]  || '').trim() || null,
  };
}

module.exports = { load, getIdentity, COL_NAME, COL_INDUSTRY_GRP, COL_NSE_BASIC_IND, COL_NSE_SYMBOL };
