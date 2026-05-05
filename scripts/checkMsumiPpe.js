'use strict';
const { parse } = require('csv-parse/sync');
const fs = require('fs'), path = require('path');
const records = parse(fs.readFileSync(path.join(__dirname, '../tmp/Mar2025_annual.csv')), { bom: true, relax_column_count: true });
const headers = records[5];
const dataRows = records.slice(6).filter(r => (r[0] || '').trim());
const colMap = {};
headers.forEach((h, i) => { const t = h.trim(); if (t && !(t in colMap)) colMap[t] = i; });
const row = dataRows.find(r => r[0].includes('Motherson Sumi Wiring'));
if (!row) { console.log('MSUMI not found'); process.exit(); }
const ppeCols = [
  'Net land and buildings, including bearer plants',
  'Gross land and buildings, including bearer plants',
  'Net plant & machinery, computers and electrical installations',
  'Gross plant & machinery, computers and electrical installations',
  'Net computers and IT systems',
  'Net electrical installations & fittings',
  'Net transport & communication equipment and infrastructure',
  'Net furniture and other fixed assets',
  'Net buildings',
  'Net leasehold improvements',
  'Net mining / oil & gas properties',
  'Net biological assets - bearer plants',
];
ppeCols.forEach(c => {
  const val = colMap[c] !== undefined ? (row[colMap[c]] || '(empty)') : '(col not found)';
  console.log(c.slice(0, 60).padEnd(61), ':', val);
});
