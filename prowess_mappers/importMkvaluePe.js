'use strict';

/**
 * prowess_mappers/importMkvaluePe.js
 *
 * Imports daily PE + Enterprise Value from tmp/mkvalue_pe.csv into nse_equity
 * (pe + market_cap_cr columns). Matches Prowess company names → NSE tickers
 * via the inverted prowessResolver TICKER_MAP.
 *
 * Usage:
 *   node prowess_mappers/importMkvaluePe.js             # verify only
 *   node prowess_mappers/importMkvaluePe.js --insert    # write to DB
 *   node prowess_mappers/importMkvaluePe.js --limit=10 --insert
 *   node prowess_mappers/importMkvaluePe.js --csv=tmp/other.csv --insert
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

const doInsert = process.argv.includes('--insert');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const rowLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const csvArg   = process.argv.find(a => a.startsWith('--csv='));
const csvPath  = csvArg
  ? path.resolve(csvArg.split('=')[1])
  : path.join(__dirname, '../tmp/mkvalue_pe.csv');

// Build inverse map: prowessName → NSE ticker by parsing the TICKER_MAP literal
function buildInverseMap() {
  const src      = fs.readFileSync(path.join(__dirname, '../utils/prowessResolver.js'), 'utf8');
  const mapMatch = src.match(/const TICKER_MAP\s*=\s*(\{[\s\S]*?\});/);
  if (!mapMatch) throw new Error('Could not extract TICKER_MAP from prowessResolver.js');
  // eslint-disable-next-line no-new-func
  const TICKER_MAP = new Function(`return ${mapMatch[1]}`)();
  const inverse = {};
  for (const [ticker, prowessName] of Object.entries(TICKER_MAP)) {
    inverse[prowessName] = ticker;
  }
  return inverse;
}

const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

function parseDate(str) {
  // "01 Jul 2025" → UTC midnight (avoid IST offset shifting the calendar date)
  const [day, mon, year] = str.trim().split(' ');
  return new Date(Date.UTC(parseInt(year), MONTHS[mon], parseInt(day)));
}

async function run() {
  console.log('=== importMkvaluePe ===');
  console.log(`CSV  : ${csvPath}`);
  console.log(`Mode : ${doInsert ? 'INSERT/UPDATE' : 'verify only'}\n`);

  const raw  = fs.readFileSync(csvPath);
  const rows = parse(raw, { bom: true, relax_column_count: true });

  // Row 4 = dates, Row 5 = headers, Row 6+ = data
  const dateRow  = rows[4];
  const dataRows = rows.slice(6);
  const colCount = rows[5].length;

  // Build date-column pairs: each trading day occupies 2 columns (P/E, Enterprise value)
  const dateCols = [];
  for (let c = 1; c < colCount; c += 2) {
    dateCols.push({ colPe: c, colEv: c + 1, date: parseDate(dateRow[c]) });
  }

  console.log(`Trading days : ${dateCols.length}`);
  console.log(`Companies    : ${dataRows.length}`);

  const inverseMap = buildInverseMap();
  console.log(`Ticker map   : ${Object.keys(inverseMap).length} prowess→ticker entries\n`);

  // Build rows
  const allRows = [];
  let unresolved = 0;
  const unresolvedSample = [];

  const companies = isFinite(rowLimit) ? dataRows.slice(0, rowLimit) : dataRows;

  for (const row of companies) {
    const prowessName = row[0]?.trim();
    if (!prowessName) continue;

    const ticker = inverseMap[prowessName];
    if (!ticker) {
      unresolved++;
      if (unresolvedSample.length < 5) unresolvedSample.push(prowessName);
      continue;
    }

    for (const { colPe, colEv, date } of dateCols) {
      const rawPe = row[colPe];
      const rawEv = row[colEv];
      if (!rawPe && !rawEv) continue;

      const pe           = rawPe ? parseFloat(rawPe) : null;
      const market_cap_cr = rawEv ? parseFloat(rawEv) : null;
      if (pe === null && market_cap_cr === null) continue;

      allRows.push({ symbol: ticker, datetime: date, pe, market_cap_cr });
    }
  }

  const resolved = companies.filter(r => r[0]?.trim()).length - unresolved;
  console.log(`Resolved     : ${resolved} companies → tickers`);
  console.log(`Unresolved   : ${unresolved} (no ticker mapping)`);
  if (unresolvedSample.length) console.log(`  e.g. ${unresolvedSample.join(', ')}`);
  console.log(`Total rows   : ${allRows.length}\n`);

  if (!doInsert) {
    console.log('(verify-only — pass --insert to write to DB)');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const BATCH = 500;
    let inserted = 0;
    let updated  = 0;

    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch  = allRows.slice(i, i + BATCH);
      const values = batch.map((_, idx) => {
        const b = idx * 4;
        return `($${b+1}, $${b+2}, $${b+3}, $${b+4})`;
      }).join(', ');

      const params = batch.flatMap(r => [r.symbol, r.datetime, r.pe, r.market_cap_cr]);

      const result = await prisma.$queryRawUnsafe(
        `INSERT INTO nse_equity (symbol, datetime, pe, market_cap_cr)
         VALUES ${values}
         ON CONFLICT (symbol, datetime) DO UPDATE
           SET pe = EXCLUDED.pe,
               market_cap_cr = EXCLUDED.market_cap_cr
         RETURNING (xmax = 0) AS was_insert`,
        ...params
      );

      for (const r of result) {
        if (r.was_insert) inserted++; else updated++;
      }
      process.stdout.write(`\r  ${Math.min(i + BATCH, allRows.length)}/${allRows.length} rows processed`);
    }

    console.log(`\n\n✓ Done — ${inserted} new rows inserted, ${updated} existing rows updated`);
  } finally {
    await prisma.$disconnect();
  }
}

run().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
