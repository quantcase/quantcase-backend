'use strict';

/**
 * prowess_mappers/importProwessNew.js
 *
 * Imports Prowess (CMIE) annual financials (dual-section: Consolidated + Standalone)
 * into prowess_values_new.
 *
 * CSV format (e.g. osc_sheet_1.csv):
 *   Row 2 : section labels ("Standardised Annual Finance Consolidated" / "Standalone")
 *   Row 3 : unit strings per column
 *   Row 4 : year labels ("Mar 2026") — one per section
 *   Row 5 : column header names
 *   Row 6+: data rows (col 0 = Company Name)
 *
 * Column mapping reference: prowess_mappers/column_mapping_new.json
 * All column lookups use NAMES not indices.
 *
 * Usage:
 *   node prowess_mappers/importProwessNew.js                   # verify only (no DB writes)
 *   node prowess_mappers/importProwessNew.js --insert          # verify + write to DB
 *   node prowess_mappers/importProwessNew.js --csv=tmp/my.csv --insert
 *   node prowess_mappers/importProwessNew.js --clear --insert  # wipe table first
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const { ProwessUploader } = require('./ProwessUploader');

const csvArg   = process.argv.find(a => a.startsWith('--csv='));
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const csvPath  = csvArg
  ? path.resolve(csvArg.split('=')[1])
  : path.join(__dirname, '../tmp/osc_sheet_1.csv');

new ProwessUploader({
  table:          'prowess_values_new',
  constraintName: 'pnv_call_kpi_unique',
  csvPath,
  doInsert:  process.argv.includes('--insert'),
  doClear:   process.argv.includes('--clear'),
  rowLimit:  limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined,
}).run('annual').catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
