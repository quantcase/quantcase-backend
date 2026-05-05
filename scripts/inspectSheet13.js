'use strict';
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const records = parse(fs.readFileSync(path.join(__dirname, '../tmp/osc_sheet_13.csv')), { bom: true, relax_column_count: true });
const headers = records[5];
const unitRow  = records[3];
const dataRows = records.slice(6).filter(r => (r[0] || '').trim());

console.log('Total companies :', dataRows.length);
console.log('Total columns   :', headers.length);
console.log('Year sample     :', records[4][1]);
console.log('');
console.log('All column headers:');
headers.forEach((h, i) => { if (h.trim()) console.log(`  [${i}] ${h.trim()} — unit: ${(unitRow[i]||'').trim()}`); });

console.log('');
const CSV_UNIT_MAP = { 'Rs. Crore': 'Cr', '(%)': '%', 'Times': 'x', 'Indian Rupee': 'Rs' };
const row = dataRows.find(r => r[0].includes('Motherson Sumi Wiring'));
if (!row) { console.log('MSUMI not found'); process.exit(); }

console.log('MSUMI row:');
headers.forEach((h, i) => {
  const raw = (row[i] || '').trim();
  if (!raw || !h.trim()) return;
  const unitRaw = (unitRow[i] || '').trim();
  const unit = CSV_UNIT_MAP[unitRaw] ?? unitRaw;
  console.log(' ', h.padEnd(50), '| raw:', String(raw).padStart(14), '| unit:', unit);
});
