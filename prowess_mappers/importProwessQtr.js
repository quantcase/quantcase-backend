'use strict';

/**
 * prowess_mappers/importProwessQtr.js
 *
 * Imports Prowess quarterly interim standalone financials into prowess_values_new.
 *
 * CSV format (e.g. quartely_2025-2026.csv):
 *   Row 2 : "Quarterly Interim Standalone" (standalone only, no consolidated section)
 *   Row 3 : unit strings per column
 *   Row 4 : quarter labels ("Mar 2025", "Jun 2025", …) — repeated per column block
 *   Row 5 : column header names (same ~50 names repeat for every quarter block)
 *   Row 6+: data rows (col 0 = Company Name, then N × 50-col quarter blocks)
 *
 * Quarter blocks are detected automatically from label changes in row 4.
 * All column lookups use NAMES not indices.
 *
 * Usage:
 *   node prowess_mappers/importProwessQtr.js                        # verify only
 *   node prowess_mappers/importProwessQtr.js --insert               # verify + write
 *   node prowess_mappers/importProwessQtr.js --csv=tmp/my.csv --insert
 *   node prowess_mappers/importProwessQtr.js --clear --insert       # wipe quarterly rows first
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const { ProwessUploader } = require('./ProwessUploader');

const csvArg   = process.argv.find(a => a.startsWith('--csv='));
const srcArg   = process.argv.find(a => a.startsWith('--source-type=') || a.startsWith('--source_type='));
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const csvPath  = csvArg
  ? path.resolve(csvArg.split('=')[1])
  : path.join(__dirname, '../tmp/quartely_2025-2026.csv');
const sourceType = srcArg ? srcArg.split('=')[1].toUpperCase() : undefined;

new ProwessUploader({
  table:          'prowess_values_new',
  constraintName: 'pnv_call_kpi_unique',
  csvPath,
  sourceType,
  doInsert: process.argv.includes('--insert'),
  doClear:  process.argv.includes('--clear'),
  rowLimit: limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined,
}).run('quarterly').catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
