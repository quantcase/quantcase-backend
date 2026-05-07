'use strict';

/**
 * prowess_mappers/importProwessQtr.js
 *
 * Imports Prowess quarterly interim standalone financials into prowess_values_new.
 *
 * CSV format (e.g. quartely_2025-2026.csv):
 *   Row 0-1 : metadata
 *   Row 2   : "Quarterly Interim Standalone" (all cols — standalone only, no consolidated section)
 *   Row 3   : unit strings per column
 *   Row 4   : quarter labels ("Mar 2025", "Jun 2025", …) — repeated for each col in that block
 *   Row 5   : column header names (same 50 names repeat for every quarter block)
 *   Row 6+  : data rows (col 0 = Company Name, then 50 cols × N quarters)
 *
 * 50 cols per block; blocks are detected automatically from row 4 label changes.
 * No Months/Source metadata cols — CSV is pre-filtered to 3-month quarters.
 *
 * Rows written to prowess_values_new:
 *   period_type = 'quarterly'  for P&L / cashflow KPIs
 *   period_type = 'snapshot'   for balance-sheet KPIs (point-in-time at quarter end)
 *   source_type = 'S'          (standalone only)
 *   callId      = prowess_qtr_${company}_${fiscalYear}_${quarter}_S
 *
 * ON CONFLICT DO NOTHING — duplicate (callId, kpi_abbr) pairs are silently skipped.
 *
 * Usage:
 *   node prowess_mappers/importProwessQtr.js                        # verify only
 *   node prowess_mappers/importProwessQtr.js --insert               # verify + write
 *   node prowess_mappers/importProwessQtr.js --csv=tmp/my.csv --insert
 *   node prowess_mappers/importProwessQtr.js --clear --insert       # wipe quarterly rows first
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
  : path.join(__dirname, '../tmp/quartely_2025-2026.csv');

const TABLE_NAME  = 'prowess_values_new';
const SOURCE_TYPE = 'S';   // standalone only

// ─── Unit / multiplier ────────────────────────────────────────────────────────

const CSV_UNIT_MAP = {
  'Rs. Crore':    'Cr',
  '(%)':          '%',
  '((%))':        '%',
  'Times':        'x',
  'Indian Rupee': 'Rs',
};

const UNIT_MULTIPLIER = { Cr: 10_000_000, '%': 1, x: 1, Rs: 1 };

// ─── Snapshot KPIs (balance-sheet — point-in-time at quarter end) ─────────────

const SNAPSHOT_ABBRS = new Set([
  'EQ_SHARE_CAP', 'RES_SURPLUS',
  'BORR_TOTAL', 'CURR_LIAB', 'PROV_LT', 'PROV_ST', 'DTL',
  'ASSET_PPE', 'ASSET_CWIP', 'INV_NONCURR', 'INV_CURR', 'OTH_ASSET_NC', 'CURR_ASSETS',
  'CASH_EQUIV', 'AUM_TOTAL',
]);

// ─── Statement classification ─────────────────────────────────────────────────

const STATEMENT_MAP = {
  TOTAL_INCOME: 'pnl',    REV_OP:    'pnl',    OTH_INC:   'pnl',
  INV_CHG:      'pnl',    COST_MAT:  'pnl',    EMP_EXP:   'pnl',
  OTH_EXP:      'pnl',    FIN_COST:  'pnl',    DEP_AMORT: 'pnl',
  PROV_CONT:    'pnl',    PAT:       'pnl',     TOTAL_OPEX:'pnl',
  EPS_BASIC:    'pnl',    EPS_DILUTED:'pnl',    NIM_PCT:   'pnl',
  EQ_SHARE_CAP: 'balance_sheet', RES_SURPLUS: 'balance_sheet',
  BORR_TOTAL:   'balance_sheet', CURR_LIAB:   'balance_sheet',
  PROV_LT:      'balance_sheet', PROV_ST:     'balance_sheet',
  DTL:          'balance_sheet', ASSET_PPE:   'balance_sheet',
  ASSET_CWIP:   'balance_sheet', INV_NONCURR: 'balance_sheet',
  INV_CURR:     'balance_sheet', OTH_ASSET_NC:'balance_sheet',
  CURR_ASSETS:  'balance_sheet', CASH_EQUIV:  'balance_sheet',
  AUM_TOTAL:    'balance_sheet',
  CFO: 'cashflow', CFI: 'cashflow', CFF: 'cashflow',
};

// ─── Column → KPI mapping ─────────────────────────────────────────────────────
// Keys are exact header strings from row 5. Only columns we want to store.
// Skip list (17 cols): BFSI-only revenues, redundant aggregates, ratio %, EPS-after-EI dupes.

const QTR_COL_MAP = {
  'Total income from continuing operations':                                          'TOTAL_INCOME',
  'Net sales':                                                                        'REV_OP',
  'Change in stock':                                                                  'INV_CHG',
  'Raw materials, stocks, spares, purchase of finished goods':                        'COST_MAT',
  'Salaries and wages':                                                               'EMP_EXP',
  'Total other expenses':                                                             'OTH_EXP',
  'Interest expenses':                                                                'FIN_COST',
  'Depreciation':                                                                     'DEP_AMORT',
  'Provisions and contingencies':                                                     'PROV_CONT',
  'Net Profit/(Loss) for the period from continuing operations (after tax)':          'PAT',
  'Paid up capital':                                                                  'EQ_SHARE_CAP',
  'Reserves':                                                                         'RES_SURPLUS',
  'Earnings per share before extraordinary item':                                     'EPS_BASIC',
  'Diluted earnings per share before extraordinary item':                             'EPS_DILUTED',
  'Borrowings':                                                                       'BORR_TOTAL',
  'Current liabilities':                                                              'CURR_LIAB',
  'Long term provisions':                                                             'PROV_LT',
  'Short term provisions':                                                            'PROV_ST',
  'Deferred tax liability':                                                           'DTL',
  'Net fixed assets':                                                                 'ASSET_PPE',
  'Capital work in progress':                                                         'ASSET_CWIP',
  'Long term investments':                                                            'INV_NONCURR',
  'Short term investments':                                                           'INV_CURR',
  'Other non-current assets':                                                         'OTH_ASSET_NC',
  'Current assets & loans and advances':                                              'CURR_ASSETS',
  // Insurance CFO (direct method) — only filled for insurance cos, empty for others
  'Net cash inflow or (outflow) from operating activities - Direct method (For insurance cos.)': 'CFO',
  'Net cash inflow or (outflow) from investing activities':                           'CFI',
  'Net cash inflow or (outflow) from financing activities':                           'CFF',
  'Cash and cash equivalents as at the end of the period':                           'CASH_EQUIV',
  'Net Interest Margin':                                                              'NIM_PCT',
  'Total outstanding AUM':                                                            'AUM_TOTAL',
  'Total expenses':                                                                   'TOTAL_OPEX',
  'Other income':                                                                     'OTH_INC',
};

// ─── Quarter helpers ──────────────────────────────────────────────────────────

/**
 * Month → quarter metadata (Indian FY: Apr–Mar).
 * fyOffset: added to the label year to get the FY year.
 * e.g. Jun 2025 → Q1 FY2026; Mar 2025 → Q4 FY2025.
 */
const MONTH_META = {
  Mar: { quarter: 'Q4', fyOffset: 0, startMon: '01' },
  Jun: { quarter: 'Q1', fyOffset: 1, startMon: '04' },
  Sep: { quarter: 'Q2', fyOffset: 1, startMon: '07' },
  Dec: { quarter: 'Q3', fyOffset: 1, startMon: '10' },
};

/**
 * Parse "Mar 2025" → { quarter, fiscalYear, endDate, startDate }
 */
function parseQuarterLabel(label) {
  const [mon, yr] = (label || '').trim().split(' ');
  const meta = MONTH_META[mon];
  if (!meta || !yr) return null;

  const year    = parseInt(yr, 10);
  const fyYear  = year + meta.fyOffset;
  const endMon  = { Mar:'03', Jun:'06', Sep:'09', Dec:'12' }[mon];
  const lastDay = new Date(year, parseInt(endMon, 10), 0).getDate();
  const endDate = `${year}-${endMon}-${String(lastDay).padStart(2, '0')}`;
  const startDate = `${year}-${meta.startMon}-01`;

  return {
    quarter:    meta.quarter,
    fiscalYear: `FY${fyYear}`,
    endDate,
    startDate,
  };
}

// ─── Name normalizer (matches annual importer) ────────────────────────────────

function normalizeName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_')
    .replace(/^_|_$/g, '').slice(0, 50);
}

// ─── Batch insert ─────────────────────────────────────────────────────────────

async function batchInsert(rows, batchSize = 500) {
  const countBefore = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE_NAME}`);
  const before = countBefore[0].n;
  let attempted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = batch.map((row, j) => {
      const b = j * 17;
      params.push(
        row.callId,      row.company,     row.fiscal_year, row.quarter,
        row.call_date,   row.kpi_abbr,    row.value,       row.raw_value,
        row.unit,        row.multiplier,  row.start_date,  row.end_date,
        row.period_type, row.source,      row.source_path, row.statement,
        row.source_type,
      );
      return (
        `(gen_random_uuid(),` +
        `$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},` +
        `$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14}::"KpiSource",$${b+15},$${b+16},NOW(),NOW(),$${b+17})`
      );
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE_NAME} (
         id, call_id, company, fiscal_year, quarter, call_date,
         kpi_abbr, value, raw_value, unit, multiplier,
         start_date, end_date, period_type, source, source_path,
         statement, created_at, updated_at, source_type
       ) VALUES ${placeholders.join(',\n')}
       ON CONFLICT ON CONSTRAINT pnv_call_kpi_unique DO NOTHING`,
      ...params
    );
    attempted += batch.length;
    process.stdout.write(`  Progress: ${attempted}/${rows.length}\r`);
  }

  const countAfter = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE_NAME}`);
  const inserted = countAfter[0].n - before;
  console.log(`\n✓ Attempted ${attempted} rows — ${inserted} inserted, ${attempted - inserted} skipped (duplicate callId+kpi_abbr)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== importProwessQtr → ${TABLE_NAME} ===`);
  console.log(DO_INSERT ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write]\n');

  // ── 1. Parse CSV ──────────────────────────────────────────────────────────────
  console.log('Parsing CSV…');
  const records = parse(fs.readFileSync(CSV_PATH), { bom: true, relax_column_count: true });
  const yearRow  = records[4];
  const headers  = records[5];
  const unitRow  = records[3];
  const dataRows = records.slice(6).filter(r => (r[0] || '').trim());

  console.log(`  Companies : ${dataRows.length}`);
  console.log(`  Columns   : ${headers.length}`);

  // Verify standalone-only
  const sectionLabel = (records[2][1] || '').trim();
  if (!sectionLabel.toLowerCase().includes('standalone')) {
    console.warn(`  WARNING: expected "Standalone" in row 2, got: "${sectionLabel}"`);
  }

  // ── 2. Detect quarter blocks from row 4 ───────────────────────────────────────
  const blocks = [];
  let cur = null;
  for (let i = 1; i < yearRow.length; i++) {
    const lbl = (yearRow[i] || '').trim();
    if (!lbl) continue;
    if (!cur || cur.label !== lbl) { cur = { label: lbl, start: i, end: i }; blocks.push(cur); }
    else cur.end = i;
  }

  console.log(`  Quarters  : ${blocks.length} (${blocks.map(b => b.label).join(', ')})`);
  if (!blocks.length) throw new Error('No quarter blocks found in row 4.');

  // Parse quarter info for each block
  for (const b of blocks) {
    b.info = parseQuarterLabel(b.label);
    if (!b.info) throw new Error(`Cannot parse quarter label: "${b.label}"`);
  }

  // ── 3. Build per-block col-name → absolute-index map ─────────────────────────
  // Also build unit lookup by absolute column index
  const colUnitByIdx = {};
  for (let i = 0; i < unitRow.length; i++) {
    const raw = (unitRow[i] || '').trim();
    colUnitByIdx[i] = CSV_UNIT_MAP[raw] ?? null;
  }

  for (const b of blocks) {
    b.colMap = {};
    for (let i = b.start; i <= b.end; i++) {
      const h = (headers[i] || '').trim();
      if (h && !(h in b.colMap)) b.colMap[h] = i;
    }
  }

  // ── 4. Validate mapped columns exist in first block ───────────────────────────
  const firstBlock = blocks[0];
  const missing = Object.keys(QTR_COL_MAP).filter(n => !(n in firstBlock.colMap));
  if (missing.length) {
    throw new Error(
      `First block missing ${missing.length} mapped column(s):\n` +
      missing.map(c => `  ✗ "${c}"`).join('\n')
    );
  }
  console.log(`\n✓ All ${Object.keys(QTR_COL_MAP).length} mapped columns found in first block.\n`);

  // ── 5. Build all rows ─────────────────────────────────────────────────────────
  console.log('Building rows…');
  const allRows = [];

  for (const dataRow of dataRows) {
    const company = (dataRow[0] || '').trim();
    if (!company) continue;

    for (const block of blocks) {
      const { quarter, fiscalYear, endDate, startDate } = block.info;
      const callId = `prowess_qtr_${normalizeName(company)}_${fiscalYear}_${quarter}_${SOURCE_TYPE}`;

      // Skip block entirely if company has no data in it
      const hasAny = Object.values(block.colMap).some(idx => (dataRow[idx] || '').trim());
      if (!hasAny) continue;

      for (const [colName, abbr] of Object.entries(QTR_COL_MAP)) {
        const idx = block.colMap[colName];
        if (idx == null) continue;
        const raw = (dataRow[idx] || '').trim();
        if (!raw) continue;
        const num = parseFloat(raw);
        if (isNaN(num)) continue;

        const unit   = colUnitByIdx[idx] ?? 'Cr';
        const mult   = UNIT_MULTIPLIER[unit] ?? 1;
        const isSnap = SNAPSHOT_ABBRS.has(abbr);

        allRows.push({
          callId,
          company,
          source_type: SOURCE_TYPE,
          fiscal_year:  fiscalYear,
          quarter,
          call_date:    endDate,
          kpi_abbr:     abbr,
          value:        parseFloat((num * mult).toFixed(4)),
          raw_value:    raw,
          unit,
          multiplier:   mult,
          start_date:   isSnap ? null : startDate,
          end_date:     endDate,
          period_type:  isSnap ? 'snapshot' : 'quarterly',
          source:       'QE',
          source_path:  `prowess/${path.basename(CSV_PATH)}`,
          statement:    STATEMENT_MAP[abbr] ?? null,
        });
      }
    }
  }

  // ── 6. Deduplicate (callId, kpi_abbr) — first occurrence wins ────────────────
  const seen      = new Set();
  const finalRows = [];
  for (const row of allRows) {
    const key = `${row.callId}|${row.kpi_abbr}`;
    if (!seen.has(key)) { seen.add(key); finalRows.push(row); }
  }

  // ── 7. Verification stats ─────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('VERIFICATION');
  console.log('─'.repeat(60));
  console.log(`Total rows built : ${finalRows.length}`);

  // Breakdown by quarter
  const byQtr = {};
  for (const r of finalRows) {
    const k = `${r.quarter} ${r.fiscal_year}`;
    byQtr[k] = (byQtr[k] || 0) + 1;
  }
  console.log('\nRows per quarter:');
  for (const [k, n] of Object.entries(byQtr)) console.log(`  ${k.padEnd(12)} : ${n}`);

  // KPI coverage
  const byAbbr = {};
  for (const r of finalRows) byAbbr[r.kpi_abbr] = (byAbbr[r.kpi_abbr] || 0) + 1;
  const sorted = Object.entries(byAbbr).sort((a, b) => b[1] - a[1]);
  console.log(`\nRows per KPI (${sorted.length} distinct):`);
  for (const [abbr, cnt] of sorted) console.log(`  ${abbr.padEnd(18)} : ${cnt}`);

  // ── 8. Spot-check ─────────────────────────────────────────────────────────────
  const targets = ['Reliance Industries Ltd.', 'Infosys Ltd.', 'Tata Consultancy Services Ltd.',
                   '20 Microns Ltd.', 'A B B India Ltd.'];
  for (const target of targets) {
    const rows = finalRows.filter(r => r.company === target);
    if (!rows.length) continue;
    const quarters = [...new Set(rows.map(r => `${r.quarter} ${r.fiscal_year}`))].sort();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Spot-check: ${target}  (${rows.length} rows, ${quarters.length} quarters)`);
    console.log('─'.repeat(60));
    // Show one quarter
    const qKey = quarters[0].split(' ');
    const qRows = rows.filter(r => r.quarter === qKey[0] && r.fiscal_year === qKey[1]);
    for (const abbr of ['REV_OP','PAT','EPS_BASIC','EPS_DILUTED','ASSET_PPE','CURR_LIAB','BORR_TOTAL','CFO','DEP_AMORT','OTH_INC']) {
      const r = qRows.find(x => x.kpi_abbr === abbr);
      if (r) {
        const display = (r.value / r.multiplier).toFixed(2);
        console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${display}  period=${r.period_type}`);
      } else {
        console.log(`  ${abbr.padEnd(14)} — not found`);
      }
    }
    break;
  }

  // ── 9. EPS sanity check ───────────────────────────────────────────────────────
  console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
  const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0).slice(0, 5);
  for (const r of epsSample) {
    const ok = r.multiplier === 1 && r.unit === 'Rs';
    console.log(`  ${ok ? '✓' : '✗'} ${r.company.slice(0, 35).padEnd(36)} EPS=${r.raw_value}  stored=${r.value}  mult=${r.multiplier}  unit=${r.unit}`);
  }

  // ── 10. Insert or stop ────────────────────────────────────────────────────────
  if (!DO_INSERT) {
    console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
    await prisma.$disconnect();
    return;
  }

  if (DO_CLEAR) {
    console.log(`\nClearing quarterly rows from ${TABLE_NAME}…`);
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM ${TABLE_NAME} WHERE period_type = 'quarterly'`
    );
    console.log(`✓ Deleted ${deleted} quarterly rows.\n`);
  }

  console.log(`\nInserting ${finalRows.length} rows…`);
  await batchInsert(finalRows);

  // ── 11. Post-insert DB counts ─────────────────────────────────────────────────
  console.log('\nPost-insert quarterly row counts by quarter:');
  const dbCounts = await prisma.$queryRawUnsafe(
    `SELECT fiscal_year, quarter, COUNT(*)::int AS cnt
     FROM ${TABLE_NAME} WHERE period_type = 'quarterly'
     GROUP BY fiscal_year, quarter ORDER BY fiscal_year, quarter`
  );
  let total = 0;
  for (const r of dbCounts) {
    console.log(`  ${r.quarter} ${r.fiscal_year} : ${r.cnt}`);
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
