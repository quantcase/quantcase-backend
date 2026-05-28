/**
 * Ingest Prowess OHLCV CSVs from docs/ohlcv/ into nse_equity.
 *
 * File format (Prowess wide layout):
 *   Row 1: source ("CMIE Expr")
 *   Row 2: exchange ("NSE")
 *   Row 3: type ("Finance S / Interim SQ")
 *   Row 4: units ("Indian Rupee" / "Nos.")
 *   Row 5: dates — each date repeated 5 times (O/H/L/C/Vol per day)
 *   Row 6: field names ("Company Name", "Opening Price", "High Price", "Low Price", "Closing Price", "Number of Transactions", ...)
 *   Row 7+: data rows
 *
 * Company names are resolved to NSE symbols via osc_identity.csv.
 * Rows already in nse_equity (symbol + datetime) are skipped (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   node scripts/ingest_prowess_ohlcv.js             # all files
 *   node scripts/ingest_prowess_ohlcv.js --dry-run   # parse only, no DB writes
 *   node scripts/ingest_prowess_ohlcv.js --file osc_sheet_63.csv  # single file
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const OHLCV_DIR    = path.join(__dirname, '..', 'docs', 'ohlcv');
const IDENTITY_CSV = path.join(__dirname, '..', 'lib', 'osc_identity.csv');
const BATCH_SIZE   = 500; // rows per DB upsert batch

const isDryRun = process.argv.includes('--dry-run');
const fileArg  = (() => { const i = process.argv.indexOf('--file'); return i !== -1 ? process.argv[i + 1] : null; })();

const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripQuotes(s) {
  return (s || '').replace(/^"|"$/g, '').trim();
}

// Parse a CSV line respecting quoted fields (no nested quotes in these files)
function splitCsvLine(line) {
  return line.split(',').map(stripQuotes);
}

// Parse "01 Mar 2021" → Date (UTC midnight)
function parseDate(s) {
  const d = new Date(`${s} UTC`);
  return isNaN(d.getTime()) ? null : d;
}

// ── Build name → NSE symbol map from osc_identity.csv ────────────────────────

// Many rows in the identity CSV have a variable column shift — extra columns are
// inserted before the NSE symbol, pushing it 1–4 positions to the right of its
// header index. We scan forward from the expected index for the first value that
// looks like a valid NSE ticker (uppercase alphanumeric, 2–15 chars, no spaces).
const NSE_TICKER_RE = /^[A-Z0-9&-]{2,15}$/;

function extractNseSymbol(cols, symIdx) {
  for (let offset = 0; offset <= 4; offset++) {
    const val = (cols[symIdx + offset] || '').trim().toUpperCase();
    if (NSE_TICKER_RE.test(val)) return val;
  }
  return null;
}

function buildNameToSymbolMap() {
  const lines = fs.readFileSync(IDENTITY_CSV, 'utf8')
    .replace(/^﻿/, '')   // strip BOM
    .split('\n')
    .filter(Boolean);

  const header   = splitCsvLine(lines[0]);
  const nameIdx  = header.indexOf('Company Name');
  const symIdx   = header.indexOf('NSE symbol');

  if (nameIdx === -1 || symIdx === -1) throw new Error('osc_identity.csv missing expected columns');

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const name = cols[nameIdx];
    const sym  = extractNseSymbol(cols, symIdx);
    if (name && sym) map[name] = sym;
  }
  return map;
}

// ── Parse one Prowess OHLCV file → array of {symbol, datetime, open, high, low, close, volume} ──

function parseOhlcvFile(filePath, nameToSymbol) {
  const raw   = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = raw.split('\n').filter(Boolean);

  if (lines.length < 7) {
    console.warn(`  Skipping ${path.basename(filePath)}: too few rows`);
    return [];
  }

  // Row 5 (index 4): dates, each repeated 5× for the 5 fields per day
  const dateRow  = splitCsvLine(lines[4]);
  // Row 6 (index 5): field names
  const fieldRow = splitCsvLine(lines[5]);

  // Build column index: for each date, find the 5 column positions (O/H/L/C/Vol)
  // col 0 is company name; data starts at col 1
  const dayMap = {}; // date string → { open, high, low, close, vol } col indices
  for (let col = 1; col < fieldRow.length; col++) {
    const dateStr = dateRow[col];
    const field   = fieldRow[col];
    if (!dateStr || !field) continue;
    if (!dayMap[dateStr]) dayMap[dateStr] = {};
    if (field === 'Opening Price')          dayMap[dateStr].open  = col;
    else if (field === 'High Price')        dayMap[dateStr].high  = col;
    else if (field === 'Low Price')         dayMap[dateStr].low   = col;
    else if (field === 'Closing Price')     dayMap[dateStr].close = col;
    else if (field === 'Number of Transactions') dayMap[dateStr].vol = col;
  }

  const validDays = Object.entries(dayMap).filter(([, idx]) =>
    idx.open != null && idx.high != null && idx.low != null && idx.close != null
  );

  const records = [];
  let skippedName = 0;

  for (let r = 6; r < lines.length; r++) {
    const cols        = splitCsvLine(lines[r]);
    const companyName = cols[0];
    if (!companyName) continue;

    const symbol = nameToSymbol[companyName];
    if (!symbol) { skippedName++; continue; }

    for (const [dateStr, idx] of validDays) {
      const dt = parseDate(dateStr);
      if (!dt) continue;

      const open  = parseFloat(cols[idx.open]);
      const high  = parseFloat(cols[idx.high]);
      const low   = parseFloat(cols[idx.low]);
      const close = parseFloat(cols[idx.close]);
      const vol   = idx.vol != null ? parseInt(cols[idx.vol], 10) : null;

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

      records.push({ symbol, datetime: dt, open, high, low, close, volume: isNaN(vol) ? null : vol });
    }
  }

  if (skippedName > 0) console.log(`  ${skippedName} companies had no NSE symbol mapping`);
  return records;
}

// ── DB batch insert ───────────────────────────────────────────────────────────

async function insertBatch(rows) {
  // Build raw SQL for bulk insert with ON CONFLICT DO NOTHING
  // nse_equity(symbol, datetime) should have a unique constraint
  const values = rows.map((r, i) => {
    const base = i * 7;
    return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7})`;
  }).join(', ');

  const params = rows.flatMap(r => [
    r.symbol, r.datetime, r.open, r.high, r.low, r.close, r.volume ?? null,
  ]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity (symbol, datetime, open, high, low, close, volume)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO NOTHING
  `, ...params);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building name → symbol map...');
  const nameToSymbol = buildNameToSymbolMap();
  console.log(`  ${Object.keys(nameToSymbol).length} mappings loaded`);

  // Collect files to process, skip the duplicate
  let files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.csv') && f !== 'osc_sheet_60 (1).csv')
    .sort();

  if (fileArg) {
    files = files.filter(f => f === fileArg);
    if (files.length === 0) { console.error(`File not found: ${fileArg}`); process.exit(1); }
  }

  console.log(`\nProcessing ${files.length} files${isDryRun ? ' (DRY RUN)' : ''}...\n`);

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const filePath = path.join(OHLCV_DIR, file);
    console.log(`→ ${file}`);

    const records = parseOhlcvFile(filePath, nameToSymbol);
    console.log(`  Parsed ${records.length} records`);

    if (isDryRun || records.length === 0) {
      totalInserted += records.length;
      continue;
    }

    // Insert in batches
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      await insertBatch(batch);
      inserted += batch.length;
      process.stdout.write(`\r  Inserted ${inserted}/${records.length}`);
    }
    console.log(`\r  Inserted ${inserted} rows (duplicates silently skipped)`);
    totalInserted += inserted;
  }

  console.log(`\nDone. Total rows processed: ${totalInserted}`);
  if (isDryRun) console.log('(Dry run — no DB writes performed)');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
