/**
 * Ingest Prowess CSVs from extras/ohlcv/ into nse_equity.
 *
 * Two file formats are supported (auto-detected from row 6 field names):
 *
 *   OHLCV format — columns: Opening Price, High Price, Low Price, Closing Price,
 *     and optionally Number of Transactions / Shares traded, P/E, Market Capitalisation.
 *     Strategy: INSERT ... ON CONFLICT DO NOTHING (price data is authoritative).
 *
 *   Valuation format — columns: P/E, Enterprise value (no price columns).
 *     Strategy: INSERT ... ON CONFLICT DO UPDATE SET pe, market_cap_cr
 *     so existing OHLCV rows get enriched, and new sparse rows are created if missing.
 *
 * Both formats share the same 6-row Prowess header:
 *   Row 1: source ("CMIE Expr")
 *   Row 2: exchange ("NSE")
 *   Row 3: type ("Finance S / Interim SQ")
 *   Row 4: units
 *   Row 5: dates — each date repeated N times (one per field)
 *   Row 6: field names
 *   Row 7+: data rows (col 0 = Company Name)
 *
 * Company names are resolved to NSE symbols via osc_identity.csv.
 *
 * Usage:
 *   node scripts/ingest_prowess_ohlcv.js                           # dry run (parse only, no DB writes)
 *   node scripts/ingest_prowess_ohlcv.js --dispatch                # ingest all files
 *   node scripts/ingest_prowess_ohlcv.js --dispatch --file osc_sheet_63.csv  # ingest single file
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const OHLCV_DIR    = path.join(__dirname, '..', 'extras', 'ohlcv');
const IDENTITY_CSV = path.join(__dirname, '..', 'lib', 'osc_identity.csv');
const BATCH_SIZE   = 500;

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const fileArg  = (() => { const i = args.indexOf('--file'); return i !== -1 ? args[i + 1] : null; })();

const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripQuotes(s) {
  return (s || '').replace(/^"|"$/g, '').trim();
}

function splitCsvLine(line) {
  return line.split(',').map(stripQuotes);
}

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
    .replace(/^﻿/, '')
    .split('\n')
    .filter(Boolean);

  const header  = splitCsvLine(lines[0]);
  const nameIdx = header.indexOf('Company Name');
  const symIdx  = header.indexOf('NSE symbol');

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

// ── Parse file → { type, records } ──────────────────────────────────────────

function parseFile(filePath, nameToSymbol) {
  const raw   = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = raw.split('\n').filter(Boolean);

  if (lines.length < 7) {
    console.warn(`  Skipping ${path.basename(filePath)}: too few rows`);
    return { type: 'unknown', records: [] };
  }

  const dateRow  = splitCsvLine(lines[4]);
  const fieldRow = splitCsvLine(lines[5]);

  // Detect format from field names in row 6
  const fields = new Set(fieldRow);
  const hasOpening = fields.has('Opening Price') || fields.has('Adjusted Opening Price');
  const isValuation = !hasOpening && fields.has('P/E');

  // Build per-date column index map
  const dayMap = {};
  for (let col = 1; col < fieldRow.length; col++) {
    const dateStr = dateRow[col];
    const field   = fieldRow[col];
    if (!dateStr || !field) continue;
    if (!dayMap[dateStr]) dayMap[dateStr] = {};
    if      (field === 'Opening Price' || field === 'Adjusted Opening Price') dayMap[dateStr].open      = col;
    else if (field === 'High Price'    || field === 'Adjusted High Price')    dayMap[dateStr].high      = col;
    else if (field === 'Low Price'     || field === 'Adjusted Low Price')     dayMap[dateStr].low       = col;
    else if (field === 'Closing Price' || field === 'Adjusted Closing Price') dayMap[dateStr].close     = col;
    else if (field === 'Number of Transactions') dayMap[dateStr].vol       = col;
    else if (field === 'Shares traded')          dayMap[dateStr].vol       = col;
    else if (field === 'Traded Quantity')        dayMap[dateStr].vol       = col;
    else if (field === 'P/E')                    dayMap[dateStr].pe        = col;
    else if (field === 'Market Capitalisation')  dayMap[dateStr].marketCap = col;
    else if (field === 'Enterprise value')       dayMap[dateStr].marketCap = col;
  }

  const validDays = isValuation
    ? Object.entries(dayMap).filter(([, idx]) => idx.pe != null || idx.marketCap != null)
    : Object.entries(dayMap).filter(([, idx]) => idx.open != null && idx.high != null && idx.low != null && idx.close != null);

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

      if (isValuation) {
        const pe        = idx.pe        != null ? parseFloat(cols[idx.pe])        : null;
        const marketCap = idx.marketCap != null ? parseFloat(cols[idx.marketCap]) : null;
        if ((pe == null || isNaN(pe)) && (marketCap == null || isNaN(marketCap))) continue;
        records.push({
          symbol, datetime: dt,
          pe:            pe        != null && !isNaN(pe)        ? pe        : null,
          market_cap_cr: marketCap != null && !isNaN(marketCap) ? marketCap : null,
        });
      } else {
        const open      = parseFloat(cols[idx.open]);
        const high      = parseFloat(cols[idx.high]);
        const low       = parseFloat(cols[idx.low]);
        const close     = parseFloat(cols[idx.close]);
        const vol       = idx.vol       != null ? parseInt(cols[idx.vol], 10)     : null;
        const pe        = idx.pe        != null ? parseFloat(cols[idx.pe])        : null;
        const marketCap = idx.marketCap != null ? parseFloat(cols[idx.marketCap]) : null;
        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
        records.push({
          symbol, datetime: dt, open, high, low, close,
          volume:        vol       != null && !isNaN(vol)       ? vol       : null,
          pe:            pe        != null && !isNaN(pe)        ? pe        : null,
          market_cap_cr: marketCap != null && !isNaN(marketCap) ? marketCap : null,
        });
      }
    }
  }

  if (skippedName > 0) console.log(`  ${skippedName} companies had no NSE symbol mapping`);
  return { type: isValuation ? 'valuation' : 'ohlcv', records };
}

// ── DB batch insert ───────────────────────────────────────────────────────────

async function insertOhlcvBatch(rows) {
  const values = rows.map((r, i) => {
    const base = i * 9;
    return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9})`;
  }).join(', ');

  const params = rows.flatMap(r => [
    r.symbol, r.datetime, r.open, r.high, r.low, r.close,
    r.volume ?? null, r.pe ?? null, r.market_cap_cr ?? null,
  ]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity (symbol, datetime, open, high, low, close, volume, pe, market_cap_cr)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO NOTHING
  `, ...params);
}

async function insertValuationBatch(rows) {
  // Deduplicate within the batch — same (symbol, datetime) can appear multiple
  // times when P/E and Enterprise value map to the same date slot separately.
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.symbol}|${r.datetime.getTime()}`;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, { ...r }); continue; }
    if (r.pe            != null) existing.pe            = r.pe;
    if (r.market_cap_cr != null) existing.market_cap_cr = r.market_cap_cr;
  }
  const deduped = Array.from(seen.values());

  const values = deduped.map((r, i) => {
    const base = i * 4;
    return `($${base+1}, $${base+2}, $${base+3}, $${base+4})`;
  }).join(', ');

  const params = deduped.flatMap(r => [
    r.symbol, r.datetime, r.pe ?? null, r.market_cap_cr ?? null,
  ]);

  // Upsert: enrich existing OHLCV rows; insert sparse row if none exists yet.
  // Only overwrite pe/market_cap_cr when the incoming value is not null.
  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity (symbol, datetime, pe, market_cap_cr)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO UPDATE SET
      pe            = COALESCE(EXCLUDED.pe,            nse_equity.pe),
      market_cap_cr = COALESCE(EXCLUDED.market_cap_cr, nse_equity.market_cap_cr)
  `, ...params);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building name → symbol map...');
  const nameToSymbol = buildNameToSymbolMap();
  console.log(`  ${Object.keys(nameToSymbol).length} mappings loaded`);

  let files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.csv') && f !== 'osc_sheet_60 (1).csv')
    .sort();

  if (fileArg) {
    files = files.filter(f => f === fileArg);
    if (files.length === 0) { console.error(`File not found: ${fileArg}`); process.exit(1); }
  }

  console.log(`\nProcessing ${files.length} files${dispatch ? '' : ' (DRY RUN — pass --dispatch to write)'}...\n`);

  let totalInserted = 0;

  for (const file of files) {
    const filePath = path.join(OHLCV_DIR, file);
    console.log(`→ ${file}`);

    const { type, records } = parseFile(filePath, nameToSymbol);
    console.log(`  Format: ${type} | Parsed ${records.length} records`);

    if (!dispatch || records.length === 0) {
      totalInserted += records.length;
      continue;
    }

    const insertBatch = type === 'valuation' ? insertValuationBatch : insertOhlcvBatch;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      await insertBatch(records.slice(i, i + BATCH_SIZE));
      inserted += Math.min(BATCH_SIZE, records.length - i);
      process.stdout.write(`\r  Inserted ${inserted}/${records.length}`);
    }
    const note = type === 'valuation' ? 'pe/market_cap_cr upserted' : 'duplicates silently skipped';
    console.log(`\r  Inserted ${inserted} rows (${note})`);
    totalInserted += inserted;
  }

  console.log(`\nDone. Total rows processed: ${totalInserted}`);
  if (!dispatch) console.log('(Dry run — no DB writes performed)');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
