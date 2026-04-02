'use strict';

/**
 * prowess_mappers/importProwessNew.js
 *
 * Reads Prowess (CMIE) detailed annual financials from osc_sheet_1.csv
 * and inserts into `prowess_values_new` table (same schema as kpi_values).
 *
 * New CSV vs old (osc_sheet_1 (1).csv):
 *   - Standalone only (no Consolidated)
 *   - Latest year only (L = FY2025, year-end 31-03-2025)
 *   - 93 columns — covers ~47 config KPIs vs 13 in old
 *   - No 4-section loop; single flat pass per company row
 *
 * Column mapping reference: prowess_mappers/column_mapping_new.json
 *
 * All column lookups use NAMES not indices — if a mapped column is renamed
 * or removed, the script throws before touching the DB.
 *
 * Usage:
 *   node prowess_mappers/importProwessNew.js            # verify only (no DB writes)
 *   node prowess_mappers/importProwessNew.js --insert   # verify + write to DB
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs     = require('fs');
const path   = require('path');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

const prisma     = new PrismaClient();
const DO_INSERT  = process.argv.includes('--insert');
const CSV_PATH   = path.join(__dirname, '../tmp/osc_sheet_1.csv');
const TABLE_NAME = 'prowess_values_new';

// ─── Unit / multiplier ────────────────────────────────────────────────────────

/** Maps Prowess CSV unit strings → our internal unit codes. */
const CSV_UNIT_MAP = {
  'Rs. Crore':   'Cr',
  '(%)':         '%',
  'Times':       'x',
  'Indian Rupee':'Rs',   // EPS columns — already in rupees, multiplier = 1
};

/**
 * value stored in DB = raw_value × multiplier  (absolute units)
 * getTimeSeries recovers display value via value / multiplier.
 * 'Cr' → ×10M (crore → rupees); '%', 'x', 'Rs' → ×1 (no conversion)
 */
const UNIT_MULTIPLIER = { Cr: 10_000_000, '%': 1, x: 1, Rs: 1 };

// ─── KPI classification ───────────────────────────────────────────────────────

/**
 * Balance-sheet KPIs are point-in-time:
 *   period_type = 'snapshot', start_date = null
 * P&L / cashflow are annual flows:
 *   period_type = 'annual', start_date = first day of fiscal year
 */
const SNAPSHOT_ABBRS = new Set([
  // Assets
  'TOTAL_ASSETS', 'NONCURR_ASSETS', 'ASSET_PPE',    'ASSET_CWIP',   'INV_NONCURR',
  'LOANS_NONCURR','OTH_ASSET_NC',   'BANK_BAL_OTHER','CURR_ASSETS',  'INVENTORY',
  'INV_CURR',     'TRADE_RECV',     'CASH_EQUIV',    'LOANS_CURR',
  // Liabilities
  'TOTAL_LIAB',   'NONCURR_LIAB',   'DEBT_LT',       'DTL',          'PROV_LT',
  'CURR_LIAB',    'DEBT_ST',        'TRADE_PAY',      'OTH_LIAB_CURR','PROV_ST',
  // Equity
  'EQ_SHARE_CAP', 'NET_WORTH',
  // BFSI intangibles / other
  'ASSET_GW',     'ASSET_INTANG',
  // BFSI balance sheet
  'DEP_TOTAL',    'BORR_TOTAL',     'LOAN_ADV_TOTAL', 'INV_BV_TOTAL', 'WORKING_FUNDS',
]);

const STATEMENT_MAP = {
  TOTAL_INCOME:  'pnl', OTH_INC:     'pnl', TOTAL_COGS:  'pnl', COST_MAT:    'pnl',
  PURCH_STOCK:   'pnl', INV_CHG:     'pnl', TOTAL_OPEX:  'pnl', EMP_EXP:     'pnl',
  FIN_COST:      'pnl', DEP_AMORT:   'pnl', OTH_EXP:     'pnl', PROV_CONT:   'pnl',
  PBT_PRE_EXC:   'pnl', EXC_ITEMS:   'pnl', PBT:         'pnl', TAX_EXP:     'pnl',
  PAT:           'pnl', EPS_BASIC:   'pnl', EPS_DILUTED: 'pnl', NIM_PCT:     'pnl',
  REV_OP:        'pnl',
  TOTAL_ASSETS:  'balance_sheet', NONCURR_ASSETS:  'balance_sheet', ASSET_PPE:     'balance_sheet',
  ASSET_CWIP:    'balance_sheet', INV_NONCURR:     'balance_sheet', LOANS_NONCURR: 'balance_sheet',
  OTH_ASSET_NC:  'balance_sheet', BANK_BAL_OTHER:  'balance_sheet', CURR_ASSETS:   'balance_sheet',
  INVENTORY:     'balance_sheet', INV_CURR:        'balance_sheet', TRADE_RECV:    'balance_sheet',
  CASH_EQUIV:    'balance_sheet', LOANS_CURR:      'balance_sheet', TOTAL_LIAB:    'balance_sheet',
  NONCURR_LIAB:  'balance_sheet', DEBT_LT:         'balance_sheet', DTL:           'balance_sheet',
  PROV_LT:       'balance_sheet', CURR_LIAB:       'balance_sheet', DEBT_ST:       'balance_sheet',
  TRADE_PAY:     'balance_sheet', OTH_LIAB_CURR:   'balance_sheet', PROV_ST:       'balance_sheet',
  EQ_SHARE_CAP:  'balance_sheet', NET_WORTH:       'balance_sheet', ASSET_GW:      'balance_sheet',
  ASSET_INTANG:  'balance_sheet', DEP_TOTAL:       'balance_sheet', BORR_TOTAL:    'balance_sheet',
  LOAN_ADV_TOTAL:'balance_sheet', INV_BV_TOTAL:    'balance_sheet', WORKING_FUNDS: 'balance_sheet',
  CFO:           'cashflow',      CFI:             'cashflow',      CFF:           'cashflow',
  NET_CASH_CHANGE:'cashflow',
};

// ─── Column → KPI mapping (ALL references are by column NAME) ─────────────────

/**
 * Maps CSV column header name → KPI abbr.
 * These are the EXACT strings from row 6 of the CSV.
 * If any name is not found in the CSV, the script throws before any DB access.
 * See prowess_mappers/column_mapping_new.json for full reference with notes.
 *
 * Duplicate handling: 'Borrowings: Total', 'Loan advances: Total', 'Investment at BV: Total'
 * each appear twice (cols 86+89, 87+90, 88+91). buildColMap takes first occurrence.
 */
const BASE_COL_MAP = {
  // P&L — Revenue
  'Total income':                                                                             'TOTAL_INCOME',
  'Other miscellaneous and irregular income':                                                 'OTH_INC',
  // P&L — COGS
  'Cost of goods sold':                                                                       'TOTAL_COGS',
  'Raw materials, stores & spares':                                                           'COST_MAT',
  'Purchase of finished goods':                                                               'PURCH_STOCK',
  'Change in stock':                                                                          'INV_CHG',
  // P&L — Operating Expenses
  'Total expenses':                                                                           'TOTAL_OPEX',
  'Compensation to employees':                                                                'EMP_EXP',
  'Financial services expenses':                                                              'FIN_COST',
  'Amortisation':                                                                             'DEP_AMORT',
  'Expenses other than Depreciation, Interest, Taxes, Provisions and Amortizations':         'OTH_EXP',
  // P&L — Profit lines
  'Net profit before tax and extra ordinary items':                                           'PBT_PRE_EXC',
  'Extra-ordinary expenses':                                                                  'EXC_ITEMS',
  'PBT':                                                                                      'PBT',
  'Provision for direct tax':                                                                 'TAX_EXP',
  'Profit after tax (PAT)':                                                                   'PAT',
  'Eps basic, AS 20':                                                                         'EPS_BASIC',
  'Eps diluted, AS 20':                                                                       'EPS_DILUTED',
  // P&L — BFSI
  'Provisions for NPAs':                                                                      'PROV_CONT',
  'Net Interest Margin (NIM) (%)':                                                            'NIM_PCT',
  // Balance Sheet — Assets
  'Total assets':                                                                             'TOTAL_ASSETS',
  'Non-current assets':                                                                       'NONCURR_ASSETS',
  'Net goodwill':                                                                             'ASSET_GW',
  'Net other intangible assets':                                                              'ASSET_INTANG',
  'Net property, plant and equipment':                                                        'ASSET_PPE',
  'CWIP & Intangible assets under development (net of impairment)':                          'ASSET_CWIP',
  'Long term investments':                                                                    'INV_NONCURR',
  'Total long term loans & advances':                                                         'LOANS_NONCURR',
  'Other long term assets':                                                                   'OTH_ASSET_NC',
  'Long term bank balance':                                                                   'BANK_BAL_OTHER',
  'Current assets (incl. short term investments, loans & advances)':                         'CURR_ASSETS',
  'Short term investments':                                                                   'INV_CURR',
  'Short term inventories':                                                                   'INVENTORY',
  'Short term trade receivables & bills receivable':                                          'TRADE_RECV',
  'Cash & Bank balance (short term)':                                                         'CASH_EQUIV',
  'Total short term loans & advances':                                                        'LOANS_CURR',
  // Balance Sheet — Liabilities
  'Total liabilities excluding Capital & Reserves':                                           'TOTAL_LIAB',
  'Non-current liabilities':                                                                  'NONCURR_LIAB',
  'Long term borrowings excl current portion':                                                'DEBT_LT',
  'Deferred tax liability':                                                                   'DTL',
  'Long term provisions':                                                                     'PROV_LT',
  'Current liabilities':                                                                      'CURR_LIAB',
  'Short-term borrowings':                                                                    'DEBT_ST',
  'Short term trade payables and acceptances':                                                'TRADE_PAY',
  'Other current liabilities':                                                                'OTH_LIAB_CURR',
  'Provisions outstanding (short term)':                                                     'PROV_ST',
  // Balance Sheet — Equity
  'Paid up equity capital (net of forfeited equity capital)':                                 'EQ_SHARE_CAP',
  'Net worth':                                                                                'NET_WORTH',
  // Cashflow
  'Net cash flow from operating activities':                                                  'CFO',
  'Net cash inflow or (outflow) from investing activities':                                   'CFI',
  'Net cash inflow or (outflow) from financing activities':                                   'CFF',
  'Net cash inflow or (outflow) due to net increase or (decrease) in cash and cash equivalents': 'NET_CASH_CHANGE',
  // BFSI balance sheet
  'Working funds':           'WORKING_FUNDS',
  'Deposits: Total':         'DEP_TOTAL',
  'Borrowings: Total':       'BORR_TOTAL',      // first occurrence (col 86); col 89 auto-skipped
  'Loan advances: Total':    'LOAN_ADV_TOTAL',  // first occurrence (col 87); col 90 auto-skipped
  'Investment at BV: Total': 'INV_BV_TOTAL',    // first occurrence (col 88); col 91 auto-skipped
};

/** REV_OP: first non-empty of these two column names wins. */
const REV_OP_COL_NON_FIN = 'Operating income for non-financial Cos.';
const REV_OP_COL_FIN     = 'Operating income for financial Cos.';

// Names of the metadata columns (never KPI data)
const COMPANY_COL = 'Company Name';
const YEAR_COL    = 'Year';
const MONTHS_COL  = 'Months';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_')
    .replace(/^_|_$/g, '').slice(0, 50);
}

/** "31-03-2025" → "FY2025" */
function deriveFiscalYear(dateStr) {
  const [, , yyyy] = dateStr.split('-');
  return yyyy ? `FY${yyyy}` : null;
}

/** "31-03-2025" → "2025-03-31" */
function toIso(dateStr) {
  const [dd, mm, yyyy] = dateStr.split('-');
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** "2025-03-31" → "2024-04-01" (start of 12-month period ending on that date) */
function startOfPeriod(endIso) {
  if (!endIso) return null;
  const d = new Date(endIso);
  d.setFullYear(d.getFullYear() - 1);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Build colName → absolute column index.
 * First occurrence wins when the same name appears multiple times (e.g. duplicate BFSI cols).
 */
function buildColMap(headers) {
  const map = {};
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').trim();
    if (h && !(h in map)) map[h] = i;
  }
  return map;
}

// ─── Table creation ───────────────────────────────────────────────────────────

async function ensureTable() {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (LIKE kpi_values INCLUDING DEFAULTS)`);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pnv_call_kpi_unique') THEN
        ALTER TABLE ${TABLE_NAME} ADD CONSTRAINT pnv_call_kpi_unique UNIQUE (call_id, kpi_abbr);
      END IF;
    END $$
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_call_id      ON ${TABLE_NAME} (call_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_company_fy_q ON ${TABLE_NAME} (company, fiscal_year, quarter)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_company_kpi  ON ${TABLE_NAME} (company, kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_kpi          ON ${TABLE_NAME} (kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_kpi_period   ON ${TABLE_NAME} (kpi_abbr, period_type)`);
}

// ─── Batch insert ─────────────────────────────────────────────────────────────

async function batchInsert(rows, batchSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = batch.map((row, j) => {
      const b = j * 16;
      params.push(
        row.callId,      row.company,     row.fiscal_year, row.quarter,
        row.call_date,   row.kpi_abbr,    row.value,       row.raw_value,
        row.unit,        row.multiplier,  row.start_date,  row.end_date,
        row.period_type, row.source,      row.source_path, row.statement,
      );
      return (
        `(gen_random_uuid(),` +
        `$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},` +
        `$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14}::"KpiSource",$${b+15},$${b+16},NOW(),NOW())`
      );
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE_NAME} (
         id, call_id, company, fiscal_year, quarter, call_date,
         kpi_abbr, value, raw_value, unit, multiplier,
         start_date, end_date, period_type, source, source_path,
         statement, created_at, updated_at
       ) VALUES ${placeholders.join(',\n')}
       ON CONFLICT ON CONSTRAINT pnv_call_kpi_unique DO NOTHING`,
      ...params
    );
    inserted += batch.length;
    process.stdout.write(`  Progress: ${inserted}/${rows.length}\r`);
  }
  console.log(`\n✓ Inserted ${inserted} rows into ${TABLE_NAME}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== importProwessNew → ${TABLE_NAME} ===`);
  console.log(DO_INSERT ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write to DB]\n');

  // ── 1. Parse CSV ──────────────────────────────────────────────────────────────
  console.log('Parsing CSV…');
  const records  = parse(fs.readFileSync(CSV_PATH), { bom: true, relax_column_count: true });
  const headers  = records[5];          // row 6 = column names
  const unitRow  = records[3];          // row 4 = unit strings
  const dataRows = records.slice(6).filter(r => (r[0] || '').trim());

  console.log(`  Companies : ${dataRows.length}`);
  console.log(`  Columns   : ${headers.length}`);

  // ── 2. Build name→index map ──────────────────────────────────────────────────
  const colMap = buildColMap(headers);

  // ── 3. Validate ALL mapped columns exist — fail loudly if any are missing ────
  const requiredCols = [
    ...Object.keys(BASE_COL_MAP),
    REV_OP_COL_NON_FIN, REV_OP_COL_FIN,
    COMPANY_COL, YEAR_COL, MONTHS_COL,
  ];
  const missingCols = requiredCols.filter(name => !(name in colMap));
  if (missingCols.length) {
    throw new Error(
      `CSV is missing ${missingCols.length} expected column(s):\n` +
      missingCols.map(c => `  ✗ "${c}"`).join('\n') +
      '\n\nUpdate BASE_COL_MAP if Prowess renamed these columns.'
    );
  }
  console.log(`\n✓ All ${requiredCols.length} expected column names found in CSV.\n`);

  // ── 4. Build name→unit map (derived from the CSV units row, by column name) ──
  // This way units are always tied to the column name, never to a position.
  const colUnitByName = {};
  for (const [name, idx] of Object.entries(colMap)) {
    const raw = (unitRow[idx] || '').trim();
    colUnitByName[name] = CSV_UNIT_MAP[raw] ?? null;
  }

  // ── 5. Build all rows ─────────────────────────────────────────────────────────
  console.log('Building rows…');
  const allRows = [];

  for (const dataRow of dataRows) {
    const company = (dataRow[colMap[COMPANY_COL]] || '').trim();
    if (!company) continue;

    const yearRaw = (dataRow[colMap[YEAR_COL]]   || '').trim();
    const months  = (dataRow[colMap[MONTHS_COL]] || '').trim();

    if (!yearRaw) continue;
    if (months && months !== '12') continue;  // skip partial-year entries

    const endDate    = toIso(yearRaw);
    const fiscalYear = deriveFiscalYear(yearRaw);
    if (!endDate || !fiscalYear) continue;

    const startDate   = startOfPeriod(endDate);
    const callId      = `prowess_new_${normalizeName(company)}_${fiscalYear}_S`;

    function pushRow(colName, abbr) {
      const idx = colMap[colName];
      const raw = (dataRow[idx] || '').trim();
      if (!raw) return;

      const num  = parseFloat(raw);
      if (isNaN(num)) return;

      const unit   = colUnitByName[colName] ?? 'Cr';
      const mult   = UNIT_MULTIPLIER[unit]  ?? 1;
      const isSnap = SNAPSHOT_ABBRS.has(abbr);

      allRows.push({
        callId,
        company,
        fiscal_year:  fiscalYear,
        quarter:      'Q4',
        call_date:    endDate,
        kpi_abbr:     abbr,
        value:        parseFloat((num * mult).toFixed(4)),
        raw_value:    raw,
        unit,
        multiplier:   mult,
        start_date:   isSnap ? null : startDate,
        end_date:     endDate,
        period_type:  isSnap ? 'snapshot' : 'annual',
        source:       'QE',
        source_path:  'prowess/osc_sheet_1.csv',
        statement:    STATEMENT_MAP[abbr] ?? null,
      });
    }

    // Mapped columns — all referenced by name
    for (const [colName, abbr] of Object.entries(BASE_COL_MAP)) {
      pushRow(colName, abbr);
    }

    // REV_OP: first non-empty of the two mutually-exclusive columns
    const revRaw =
      (dataRow[colMap[REV_OP_COL_NON_FIN]] || '').trim() ||
      (dataRow[colMap[REV_OP_COL_FIN]]     || '').trim() || null;
    if (revRaw) {
      const colName = (dataRow[colMap[REV_OP_COL_NON_FIN]] || '').trim()
        ? REV_OP_COL_NON_FIN : REV_OP_COL_FIN;
      pushRow(colName, 'REV_OP');
    }
  }

  // ── 6. Deduplicate (callId, kpi_abbr) — keep first occurrence ─────────────────
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

  const countByAbbr = {};
  for (const r of finalRows) countByAbbr[r.kpi_abbr] = (countByAbbr[r.kpi_abbr] || 0) + 1;
  const sorted = Object.entries(countByAbbr).sort((a, b) => b[1] - a[1]);
  console.log(`\nRows per KPI (${sorted.length} distinct KPIs):`);
  for (const [abbr, cnt] of sorted) console.log(`  ${abbr.padEnd(18)} : ${cnt}`);

  // ── 8. Spot-check: sample rows for a known company ────────────────────────────
  const targets = ['Samvardhana Motherson Intl. Ltd.', 'Reliance Industries Ltd.', 'Infosys Ltd.'];
  for (const target of targets) {
    const rows = finalRows.filter(r => r.company === target);
    if (!rows.length) continue;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Spot-check: ${target}  (${rows.length} KPI rows)`);
    console.log('─'.repeat(60));

    for (const abbr of ['REV_OP','PAT','EPS_BASIC','ASSET_PPE','DEBT_LT','CURR_LIAB','NET_WORTH','EMP_EXP','CFO','TRADE_RECV']) {
      const r = rows.find(x => x.kpi_abbr === abbr);
      if (r) {
        const display = (r.value / r.multiplier).toFixed(2);
        console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${display} Cr  period=${r.period_type}  stmt=${r.statement}`);
      } else {
        console.log(`  ${abbr.padEnd(14)} — not found`);
      }
    }
    break;
  }

  // ── 9. EPS sanity check (must NOT be multiplied by 10M) ─────────────────────
  console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
  const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0).slice(0, 5);
  if (epsSample.length) {
    for (const r of epsSample) {
      const ok = r.multiplier === 1 && r.unit === 'Rs';
      console.log(`  ${(ok ? '✓' : '✗')} ${r.company.slice(0, 35).padEnd(36)} EPS=${r.raw_value} Rs  stored=${r.value}  mult=${r.multiplier}  unit=${r.unit}`);
    }
  } else {
    console.log('  (no EPS rows found)');
  }

  // ── 10. Insert or stop ────────────────────────────────────────────────────────
  if (!DO_INSERT) {
    console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nCreating table ${TABLE_NAME}…`);
  await ensureTable();
  console.log('done.\n');

  console.log(`Inserting ${finalRows.length} rows…`);
  await batchInsert(finalRows);

  // ── 11. Post-insert count from DB ────────────────────────────────────────────
  console.log('\nPost-insert row counts:');
  const dbCounts = await prisma.$queryRawUnsafe(
    `SELECT kpi_abbr, COUNT(*)::int AS cnt FROM ${TABLE_NAME} GROUP BY kpi_abbr ORDER BY cnt DESC`
  );
  let total = 0;
  for (const r of dbCounts) { console.log(`  ${r.kpi_abbr.padEnd(18)} : ${r.cnt}`); total += r.cnt; }
  console.log(`  ${'TOTAL'.padEnd(18)} : ${total}`);

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('\n✗ Error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
