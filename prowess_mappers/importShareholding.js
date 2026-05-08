'use strict';

/**
 * prowess_mappers/importShareholding.js
 *
 * Imports Prowess quarterly shareholding pattern data into shareholding_pattern table.
 *
 * CSV format (e.g. osc_shareholding_qtr_v1.csv):
 *   Row 0-1 : metadata ("CMIE Expr", "BSE/NSE")
 *   Row 2   : report type
 *   Row 3   : units (empty for %)
 *   Row 4   : quarter labels ("Jun 2024", "Sep 2024", …) — each repeated 35 times
 *   Row 5   : column headers (35 headers repeat per period block)
 *   Row 6+  : data rows (col 0 = Company Name, then 35 cols × N quarters)
 *
 * One row per (company, quarter_label) is written — all 35 shareholding fields as floats.
 * ON CONFLICT (company, quarter_label) → UPDATE (upsert), so re-running is safe.
 *
 * Usage:
 *   node prowess_mappers/importShareholding.js                                     # verify only
 *   node prowess_mappers/importShareholding.js --insert                            # verify + write
 *   node prowess_mappers/importShareholding.js --csv=lib/osc_shareholding_qtr_v1.csv --insert
 *   node prowess_mappers/importShareholding.js --clear --insert                    # wipe table first
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs     = require('fs');
const path   = require('path');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

const prisma    = new PrismaClient();
const DO_INSERT = process.argv.includes('--insert');
const DO_CLEAR  = process.argv.includes('--clear');
const csvArg    = process.argv.find(a => a.startsWith('--csv='));
const CSV_PATH  = csvArg
  ? path.resolve(csvArg.split('=')[1])
  : path.join(__dirname, '../lib/osc_shareholding_qtr_v1.csv');

const TABLE = 'shareholding_pattern';
const SH_COLS_PER_PERIOD = 35;

// ─── Quarter helpers ──────────────────────────────────────────────────────────

const MONTH_META = {
  Mar: { quarter: 'Q4', fyOffset: 0 },
  Jun: { quarter: 'Q1', fyOffset: 1 },
  Sep: { quarter: 'Q2', fyOffset: 1 },
  Dec: { quarter: 'Q3', fyOffset: 1 },
};

function parseQuarterLabel(label) {
  const [mon, yr] = (label || '').trim().split(' ');
  const meta = MONTH_META[mon];
  if (!meta || !yr) return null;
  const year   = parseInt(yr, 10);
  const fyYear = year + meta.fyOffset;
  return { quarterCode: meta.quarter, fiscalYear: `FY${fyYear}` };
}

// ─── Column offset → DB field name map (matches SH_OFF in lib/prowess.js) ────

const SH_FIELDS = [
  'total',                      // 0
  'promoters',                  // 1
  'indian_promoters',           // 2
  'indian_promoter_indv_huf',   // 3
  'indian_central_state_govt',  // 4
  'indian_promoter_corp',       // 5
  'indian_promoter_fi_banks',   // 6
  'other_indian_promoters',     // 7
  'foreign_promoters',          // 8
  'foreign_indv_nri',           // 9
  'foreign_promoter_corp',      // 10
  'foreign_promoter_inst',      // 11
  'promoter_qfi',               // 12
  'other_foreign_promoters',    // 13
  'persons_acting_in_concert',  // 14
  'non_promoters',              // 15
  'non_promoter_inst',          // 16
  'np_mutual_funds',            // 17
  'np_banks_fi_ins',            // 18
  'np_insurance',               // 19
  'np_fi_banks',                // 20
  'np_central_state_govt',      // 21
  'np_fiis',                    // 22
  'np_venture_capital',         // 23
  'np_foreign_venture',         // 24
  'np_qfi_inst',                // 25
  'other_inst_np',              // 26
  'np_non_inst',                // 27
  'np_corp_bodies',             // 28
  'np_individuals',             // 29
  'np_indv_upto_1l',            // 30
  'np_indv_over_1l',            // 31
  'np_qfi',                     // 32
  'other_non_inst_np',          // 33
  'custodians',                 // 34
];

function toFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ─── Batch upsert ─────────────────────────────────────────────────────────────

async function batchUpsert(rows, batchSize = 300) {
  const countBefore = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
  const before = Number(countBefore[0].n);
  let processed = 0;

  // 38 params per row: id, company, quarter_label, fiscal_year, quarter_code, 35 floats, NOW(), NOW()
  // We'll handle updated_at via SQL NOW()
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = batch.map((row, j) => {
      const b = j * 5;  // 5 scalar params; floats handled inline
      params.push(row.company, row.quarter_label, row.fiscal_year, row.quarter_code);
      // Build the 35 float literals inline (nulls are safe in SQL)
      const floatCols = SH_FIELDS.map(f => {
        const v = row[f];
        return v == null ? 'NULL' : v;
      }).join(',');
      params.push(floatCols); // unused placeholder trick — build differently below
      return null;
    });
    // Rebuild without trick — use direct SQL construction
    const valueSets = batch.map((row) => {
      const floatLiterals = SH_FIELDS.map(f => {
        const v = row[f];
        return v == null ? 'NULL' : String(v);
      }).join(', ');
      const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
      return `(gen_random_uuid(), ${esc(row.company)}, ${esc(row.quarter_label)}, ${esc(row.fiscal_year)}, ${esc(row.quarter_code)}, ${floatLiterals}, NOW(), NOW())`;
    });

    const updateCols = SH_FIELDS.map(f => `${f} = EXCLUDED.${f}`).join(', ');

    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (
         id, company, quarter_label, fiscal_year, quarter_code,
         ${SH_FIELDS.join(', ')},
         created_at, updated_at
       ) VALUES ${valueSets.join(',\n')}
       ON CONFLICT (company, quarter_label) DO UPDATE SET
         fiscal_year   = EXCLUDED.fiscal_year,
         quarter_code  = EXCLUDED.quarter_code,
         ${updateCols},
         updated_at    = NOW()`
    );
    processed += batch.length;
    process.stdout.write(`  Progress: ${processed}/${rows.length}\r`);
  }

  const countAfter = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
  const after = Number(countAfter[0].n);
  console.log(`\n✓ Processed ${processed} rows — table now has ${after} rows (was ${before})`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== importShareholding → ${TABLE} ===`);
  console.log(DO_INSERT ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write]\n');

  // ── 1. Parse CSV ──────────────────────────────────────────────────────────────
  console.log(`Parsing: ${CSV_PATH}`);
  const records  = parse(fs.readFileSync(CSV_PATH), { bom: true, relax_column_count: true });
  const quarterRow = records[4];
  const dataRows   = records.slice(6).filter(r => (r[0] || '').trim());

  console.log(`  Data rows (companies) : ${dataRows.length}`);
  console.log(`  Total columns         : ${quarterRow.length}`);

  // ── 2. Detect quarter blocks from row 4 ───────────────────────────────────────
  const blocks = [];
  let cur = null;
  for (let i = 1; i < quarterRow.length; i++) {
    const lbl = (quarterRow[i] || '').trim();
    if (!lbl) continue;
    if (!cur || cur.label !== lbl) { cur = { label: lbl, start: i }; blocks.push(cur); }
    cur.end = i;
  }

  console.log(`  Quarters detected     : ${blocks.length} (${blocks.map(b => b.label).join(', ')})`);
  if (!blocks.length) throw new Error('No quarter blocks found in row 4.');

  // Parse and validate each block
  for (const b of blocks) {
    const info = parseQuarterLabel(b.label);
    if (!info) throw new Error(`Cannot parse quarter label: "${b.label}"`);
    b.info = info;
    const colCount = b.end - b.start + 1;
    if (colCount !== SH_COLS_PER_PERIOD) {
      console.warn(`  WARNING: block "${b.label}" has ${colCount} cols (expected ${SH_COLS_PER_PERIOD})`);
    }
  }

  // ── 3. Build all rows ─────────────────────────────────────────────────────────
  console.log('\nBuilding rows…');
  const allRows = [];

  for (const dataRow of dataRows) {
    const company = (dataRow[0] || '').trim();
    if (!company) continue;

    for (const block of blocks) {
      const base = block.start;
      const record = {
        company,
        quarter_label: block.label,
        fiscal_year:   block.info.fiscalYear,
        quarter_code:  block.info.quarterCode,
      };

      let hasAny = false;
      for (let off = 0; off < SH_COLS_PER_PERIOD; off++) {
        const val = toFloat(dataRow[base + off]);
        record[SH_FIELDS[off]] = val;
        if (val != null) hasAny = true;
      }

      if (!hasAny) continue; // skip completely empty blocks
      allRows.push(record);
    }
  }

  // ── 4. Verification stats ─────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('VERIFICATION');
  console.log('─'.repeat(60));
  console.log(`Total rows built : ${allRows.length}`);
  console.log(`Expected         : ~${dataRows.length * blocks.length} (${dataRows.length} cos × ${blocks.length} qtrs)`);

  const byQtr = {};
  for (const r of allRows) {
    const k = `${r.quarter_code} ${r.fiscal_year}`;
    byQtr[k] = (byQtr[k] || 0) + 1;
  }
  console.log('\nRows per quarter:');
  for (const [k, n] of Object.entries(byQtr)) console.log(`  ${k.padEnd(12)} : ${n}`);

  // Spot-check a known company
  const TARGETS = ['Reliance Industries Ltd.', 'Infosys Ltd.', 'Tata Consultancy Services Ltd.', '20 Microns Ltd.'];
  for (const target of TARGETS) {
    const rows = allRows.filter(r => r.company === target);
    if (!rows.length) continue;
    console.log(`\nSpot-check: ${target}  (${rows.length} quarters)`);
    const r = rows[rows.length - 1]; // latest
    console.log(`  ${r.quarter_label} (${r.quarter_code} ${r.fiscal_year})`);
    console.log(`  promoters    : ${r.promoters}`);
    console.log(`  np_fiis      : ${r.np_fiis}`);
    console.log(`  np_mutual_funds: ${r.np_mutual_funds}`);
    console.log(`  np_non_inst  : ${r.np_non_inst}`);
    console.log(`  total        : ${r.total}`);
    break;
  }

  // ── 5. Insert or stop ────────────────────────────────────────────────────────
  if (!DO_INSERT) {
    console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
    await prisma.$disconnect();
    return;
  }

  if (DO_CLEAR) {
    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE}`);
    console.log(`\n✓ Cleared ${deleted} rows from ${TABLE}.\n`);
  }

  console.log(`\nUpserting ${allRows.length} rows…`);
  await batchUpsert(allRows);

  // ── 6. Post-insert counts ─────────────────────────────────────────────────────
  console.log('\nPost-insert counts by quarter:');
  const dbCounts = await prisma.$queryRawUnsafe(
    `SELECT fiscal_year, quarter_code, COUNT(*)::int AS cnt
     FROM ${TABLE}
     GROUP BY fiscal_year, quarter_code
     ORDER BY fiscal_year, quarter_code`
  );
  let total = 0;
  for (const r of dbCounts) {
    console.log(`  ${r.quarter_code} ${r.fiscal_year} : ${r.cnt}`);
    total += r.cnt;
  }
  console.log(`  TOTAL       : ${total}`);

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('\n✗ Error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
