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
const DO_CLEAR   = process.argv.includes('--clear');
const csvArg     = process.argv.find(a => a.startsWith('--csv='));
const CSV_PATH   = csvArg
  ? path.resolve(csvArg.split('=')[1])
  : path.join(__dirname, '../tmp/osc_sheet_1.csv');
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
  // PPE breakdown
  'ASSET_LAND_NET','ASSET_MINING_NET','ASSET_BIO_NET','ASSET_LEASE_IMP_NET','ASSET_BLDG_NET',
  'ASSET_LAND_GRS','ASSET_PM_NET',   'ASSET_IT_NET', 'ASSET_ELEC_NET','ASSET_PM_GRS',
  'ASSET_TRANS_NET','ASSET_FURN_NET',
  // Liabilities
  'TOTAL_LIAB',   'NONCURR_LIAB',   'DEBT_LT',       'DTL',          'PROV_LT',
  'CURR_LIAB',    'DEBT_ST',        'TRADE_PAY',      'OTH_LIAB_CURR','PROV_ST',
  // Equity
  'EQ_SHARE_CAP', 'NET_WORTH', 'RES_SURPLUS',
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
  EQ_SHARE_CAP:  'balance_sheet', NET_WORTH:       'balance_sheet', RES_SURPLUS:   'balance_sheet', ASSET_GW: 'balance_sheet',
  ASSET_INTANG:  'balance_sheet', DEP_TOTAL:       'balance_sheet', BORR_TOTAL:    'balance_sheet',
  LOAN_ADV_TOTAL:'balance_sheet', INV_BV_TOTAL:    'balance_sheet', WORKING_FUNDS: 'balance_sheet',
  CFO:              'cashflow',    CFI:               'cashflow',    CFF:              'cashflow',
  NET_CASH_CHANGE:  'cashflow',
  // PPE breakdown (balance sheet)
  ASSET_LAND_NET:    'balance_sheet', ASSET_MINING_NET:  'balance_sheet', ASSET_BIO_NET:       'balance_sheet',
  ASSET_LEASE_IMP_NET:'balance_sheet',ASSET_BLDG_NET:   'balance_sheet', ASSET_LAND_GRS:      'balance_sheet',
  ASSET_PM_NET:      'balance_sheet', ASSET_IT_NET:      'balance_sheet', ASSET_ELEC_NET:      'balance_sheet',
  ASSET_PM_GRS:      'balance_sheet', ASSET_TRANS_NET:   'balance_sheet', ASSET_FURN_NET:      'balance_sheet',
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
  'Reserves and funds':                                                                       'RES_SURPLUS',
  // Cashflow
  'Net cash flow from operating activities':          'CFO',
  'Net cash inflow or (outflow) from investing activities': 'CFI',
  'Net cash inflow or (outflow) from financing activities': 'CFF',
  // BFSI balance sheet — Working funds present in consolidated; others standalone-only
  'Working funds': 'WORKING_FUNDS',
};

/**
 * Optional columns — present in some sections/exports but not required.
 * Skipped silently if the column is absent from the section being processed.
 */
const OPTIONAL_COL_MAP = {
  // Cashflow — NET_CASH_CHANGE removed from 2026 consolidated; keep as optional fallback
  'Net cash inflow or (outflow) due to net increase or (decrease) in cash and cash equivalents': 'NET_CASH_CHANGE',
  // BFSI balance sheet — standalone-only in 2026 CSV
  'Deposits: Total':         'DEP_TOTAL',
  'Borrowings: Total':       'BORR_TOTAL',
  'Loan advances: Total':    'LOAN_ADV_TOTAL',
  'Investment at BV: Total': 'INV_BV_TOTAL',
  // Ratios and other optional columns
  'Return (cash) on capital employed':                          'ROCE',
  'Return on net worth (Return on Equity)':                     'ROE',
  'Current ratio (times)':                                      'CR',
  'Interest cover (times)':                                     'IC',
  'Capital employed':                                           'CAP_EMP',
  'Debt to equity ratio (times)':                               'DE',
  // PPE breakdown — Mar2025_annual.csv onwards (cols 96–107)
  'Net land and buildings, including bearer plants':            'ASSET_LAND_NET',
  'Net mining / oil & gas properties':                          'ASSET_MINING_NET',
  'Net biological assets - bearer plants':                      'ASSET_BIO_NET',
  'Net leasehold improvements':                                 'ASSET_LEASE_IMP_NET',
  'Net buildings':                                              'ASSET_BLDG_NET',
  'Gross land and buildings, including bearer plants':          'ASSET_LAND_GRS',
  'Net plant & machinery, computers and electrical installations': 'ASSET_PM_NET',
  'Net computers and IT systems':                               'ASSET_IT_NET',
  'Net electrical installations & fittings':                    'ASSET_ELEC_NET',
  'Gross plant & machinery, computers and electrical installations': 'ASSET_PM_GRS',
  'Net transport & communication equipment and infrastructure': 'ASSET_TRANS_NET',
  'Net furniture and other fixed assets':                       'ASSET_FURN_NET',
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
 * Parse "Mar 2026" (from 2026+ dual-section CSV year-label row) into
 * { endDate: '2026-03-31', fiscalYear: 'FY2026' }.
 */
function parseYearLabel(label) {
  const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const [mon, yr] = (label || '').trim().split(' ');
  const mm = MON[mon];
  if (!mm || !yr) return null;
  const lastDay = new Date(parseInt(yr), parseInt(mm), 0).getDate();
  const endDate  = `${yr}-${mm}-${String(lastDay).padStart(2, '0')}`;
  return { endDate, fiscalYear: `FY${yr}` };
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

/**
 * For dual-section CSVs (2026+): split headers into two section-specific maps.
 * consMap covers cols from 1 up to (not including) stanStart.
 * stanMap covers cols from stanStart to end.
 * effectiveMap(preferred) = preferred section + any col only in the other section.
 */
function buildSectionColMaps(headers, sectionRow) {
  let stanStart = null;
  for (let i = 1; i < sectionRow.length; i++) {
    if ((sectionRow[i] || '').includes('Standalone')) { stanStart = i; break; }
  }
  const consMap = {}, stanMap = {};
  for (let i = 1; i < headers.length; i++) {
    const h = (headers[i] || '').trim();
    if (!h) continue;
    if (stanStart && i >= stanStart) { if (!(h in stanMap)) stanMap[h] = i; }
    else                             { if (!(h in consMap)) consMap[h] = i; }
  }
  return { consMap, stanMap, stanStart };
}

/** Merge two column maps: base wins, fallback fills any missing keys. */
function mergeColMaps(base, fallback) {
  const out = { ...base };
  for (const [k, v] of Object.entries(fallback)) if (!(k in out)) out[k] = v;
  return out;
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
  // Add source_type column if migrating an existing table (new tables get it via schema)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS source_type VARCHAR(1) NOT NULL DEFAULT 'C'
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_call_id         ON ${TABLE_NAME} (call_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_company_fy_q    ON ${TABLE_NAME} (company, fiscal_year, quarter)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_company_kpi     ON ${TABLE_NAME} (company, kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_kpi             ON ${TABLE_NAME} (kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_kpi_period      ON ${TABLE_NAME} (kpi_abbr, period_type)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pnv_company_srctype ON ${TABLE_NAME} (company, source_type)`);
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
  const actuallyInserted = countAfter[0].n - before;
  console.log(`\n✓ Attempted ${attempted} rows — ${actuallyInserted} actually inserted (${attempted - actuallyInserted} skipped as duplicates)`);
}

// ─── KPI seeding ──────────────────────────────────────────────────────────────

const PPE_BREAKDOWN_KPIS = [
  { abbr: 'ASSET_LAND_NET',     full_form: 'Net Land and Buildings (incl. Bearer Plants)',              kpi_type: 'assets' },
  { abbr: 'ASSET_MINING_NET',   full_form: 'Net Mining / Oil & Gas Properties',                         kpi_type: 'assets' },
  { abbr: 'ASSET_BIO_NET',      full_form: 'Net Biological Assets – Bearer Plants',                     kpi_type: 'assets' },
  { abbr: 'ASSET_LEASE_IMP_NET',full_form: 'Net Leasehold Improvements',                                kpi_type: 'assets' },
  { abbr: 'ASSET_BLDG_NET',     full_form: 'Net Buildings',                                             kpi_type: 'assets' },
  { abbr: 'ASSET_LAND_GRS',     full_form: 'Gross Land and Buildings (incl. Bearer Plants)',             kpi_type: 'assets' },
  { abbr: 'ASSET_PM_NET',       full_form: 'Net Plant & Machinery, Computers and Electrical Installations', kpi_type: 'assets' },
  { abbr: 'ASSET_IT_NET',       full_form: 'Net Computers and IT Systems',                              kpi_type: 'assets' },
  { abbr: 'ASSET_ELEC_NET',     full_form: 'Net Electrical Installations & Fittings',                   kpi_type: 'assets' },
  { abbr: 'ASSET_PM_GRS',       full_form: 'Gross Plant & Machinery, Computers and Electrical Installations', kpi_type: 'assets' },
  { abbr: 'ASSET_TRANS_NET',    full_form: 'Net Transport & Communication Equipment and Infrastructure', kpi_type: 'assets' },
  { abbr: 'ASSET_FURN_NET',     full_form: 'Net Furniture and Other Fixed Assets',                      kpi_type: 'assets' },
];

async function seedPpeKpis() {
  let created = 0, skipped = 0;
  for (const kpi of PPE_BREAKDOWN_KPIS) {
    const existing = await prisma.kpi.findFirst({ where: { abbr: kpi.abbr } });
    if (existing) { skipped++; continue; }
    await prisma.kpi.create({
      data: { abbr: kpi.abbr, full_form: kpi.full_form, kpi_type: kpi.kpi_type, denomination: 'rupee', industry: [], source: 'QE' },
    });
    created++;
  }
  console.log(`✓ KPI seed: ${created} created, ${skipped} already existed`);
}

// ─── DEP_AMORT priority chain (first non-empty wins per section) ──────────────
// 2026 CSV uses a new primary column; older names are fallbacks.
const DEP_AMORT_COLS = [
  'Depreciation / Amortisation (net of transfer from revaluation reserves)',
  'Amortisation',
  'Non-cash charges',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== importProwessNew → ${TABLE_NAME} (2026 dual-section format) ===`);
  console.log(DO_INSERT ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write to DB]\n');

  // ── 1. Parse CSV ──────────────────────────────────────────────────────────────
  console.log('Parsing CSV…');
  const records    = parse(fs.readFileSync(CSV_PATH), { bom: true, relax_column_count: true });
  const sectionRow = records[2]; // "Standardised Annual Finance Consolidated" / "Standalone"
  const unitRow    = records[3]; // unit strings per column
  const yearRow    = records[4]; // "Mar 2026" per column
  const headers    = records[5]; // column header names
  const dataRows   = records.slice(6).filter(r => (r[0] || '').trim());

  console.log(`  Companies : ${dataRows.length}`);
  console.log(`  Columns   : ${headers.length}`);

  // ── 2. Build per-section column maps (name → absolute index) ─────────────────
  const { consMap, stanMap, stanStart } = buildSectionColMaps(headers, sectionRow);
  console.log(`  Consolidated cols : ${Object.keys(consMap).length}  (cols 1–${stanStart - 1})`);
  console.log(`  Standalone cols   : ${Object.keys(stanMap).length}  (cols ${stanStart}–${headers.length - 1})`);

  // ── 3. Parse year for each section from the year-label row ───────────────────
  const consFirstIdx = Object.values(consMap)[0];
  const consYearInfo = parseYearLabel((yearRow[consFirstIdx] || '').trim());
  const stanYearInfo = stanStart ? parseYearLabel((yearRow[stanStart] || '').trim()) : null;

  if (!consYearInfo) throw new Error(`Could not parse consolidated year label from row 5: "${yearRow[consFirstIdx]}"`);
  console.log(`  Consolidated year : ${consYearInfo.fiscalYear} (end ${consYearInfo.endDate})`);
  if (stanYearInfo) console.log(`  Standalone year   : ${stanYearInfo.fiscalYear} (end ${stanYearInfo.endDate})`);

  // ── 4. Validate required columns exist in each section ────────────────────────
  const requiredCols = [...Object.keys(BASE_COL_MAP), REV_OP_COL_NON_FIN, REV_OP_COL_FIN, COMPANY_COL];
  const consMissing  = requiredCols.filter(n => n !== COMPANY_COL && !(n in consMap));
  if (consMissing.length) {
    throw new Error(
      `Consolidated section missing ${consMissing.length} column(s):\n` +
      consMissing.map(c => `  ✗ "${c}"`).join('\n')
    );
  }
  console.log(`\n✓ All ${requiredCols.length - 1} expected columns found in consolidated section.\n`);

  // ── 5. Build per-column unit lookup by absolute column index ─────────────────
  const colUnitByIdx = {};
  for (let i = 0; i < headers.length; i++) {
    const raw = (unitRow[i] || '').trim();
    colUnitByIdx[i] = CSV_UNIT_MAP[raw] ?? null;
  }

  // ── 6. Build all rows ─────────────────────────────────────────────────────────
  console.log('Building rows…');
  const allRows = [];

  /**
   * Extract KPI rows from one section of a data row.
   * sectionColMap: { colName → absoluteColIndex } for this section.
   * yearInfo: { endDate, fiscalYear }.
   * sourceType: 'C' or 'S'.
   */
  function processSection(dataRow, company, sectionColMap, yearInfo, sourceType) {
    const { endDate, fiscalYear } = yearInfo;
    const startDate = startOfPeriod(endDate);
    const callId    = `prowess_new_${normalizeName(company)}_${fiscalYear}_${sourceType}`;

    function pushRow(colName, abbr) {
      const idx = sectionColMap[colName];
      if (idx == null) return;
      const raw = (dataRow[idx] || '').trim();
      if (!raw) return;
      const num = parseFloat(raw);
      if (isNaN(num)) return;

      const unit   = colUnitByIdx[idx] ?? 'Cr';
      const mult   = UNIT_MULTIPLIER[unit] ?? 1;
      const isSnap = SNAPSHOT_ABBRS.has(abbr);

      allRows.push({
        callId, company, source_type: sourceType,
        fiscal_year: fiscalYear, quarter: 'Q4', call_date: endDate,
        kpi_abbr:    abbr,
        value:       parseFloat((num * mult).toFixed(4)),
        raw_value:   raw, unit, multiplier: mult,
        start_date:  isSnap ? null : startDate,
        end_date:    endDate,
        period_type: isSnap ? 'snapshot' : 'annual',
        source:      'QE',
        source_path: `prowess/${path.basename(CSV_PATH)}`,
        statement:   STATEMENT_MAP[abbr] ?? null,
      });
    }

    // REV_OP: first non-empty of the two mutually-exclusive operating income columns
    const nonFinRaw = (dataRow[sectionColMap[REV_OP_COL_NON_FIN]] || '').trim();
    const finRaw    = (dataRow[sectionColMap[REV_OP_COL_FIN]]     || '').trim();
    if (nonFinRaw || finRaw) {
      pushRow(nonFinRaw ? REV_OP_COL_NON_FIN : REV_OP_COL_FIN, 'REV_OP');
    }

    // Required columns (all except REV_OP, which is handled above)
    for (const [colName, abbr] of Object.entries(BASE_COL_MAP)) {
      pushRow(colName, abbr);
    }

    // Optional columns — silently skipped if absent from this section
    for (const [colName, abbr] of Object.entries(OPTIONAL_COL_MAP)) {
      if (colName in sectionColMap) pushRow(colName, abbr);
    }

    // DEP_AMORT: first non-empty column in priority chain wins
    for (const colName of DEP_AMORT_COLS) {
      const idx = sectionColMap[colName];
      if (idx != null && (dataRow[idx] || '').trim()) {
        pushRow(colName, 'DEP_AMORT');
        break;
      }
    }
  }

  for (const dataRow of dataRows) {
    const company = (dataRow[0] || '').trim();
    if (!company) continue;

    processSection(dataRow, company, consMap, consYearInfo, 'C');
    if (stanYearInfo && stanStart) {
      processSection(dataRow, company, stanMap, stanYearInfo, 'S');
    }
  }

  // ── 7. Deduplicate (callId, kpi_abbr) — keep first occurrence ─────────────────
  // callId already encodes source_type (_C / _S), so C and S never collide here.
  const seen      = new Set();
  const finalRows = [];
  for (const row of allRows) {
    const key = `${row.callId}|${row.kpi_abbr}`;
    if (!seen.has(key)) { seen.add(key); finalRows.push(row); }
  }

  // ── 8. Verification stats ─────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('VERIFICATION');
  console.log('─'.repeat(60));
  const cRows = finalRows.filter(r => r.source_type === 'C');
  const sRows = finalRows.filter(r => r.source_type === 'S');
  console.log(`Total rows built : ${finalRows.length}  (C=${cRows.length}, S=${sRows.length})`);

  const countByAbbr = {};
  for (const r of finalRows) countByAbbr[r.kpi_abbr] = (countByAbbr[r.kpi_abbr] || 0) + 1;
  const sorted = Object.entries(countByAbbr).sort((a, b) => b[1] - a[1]);
  console.log(`\nRows per KPI (${sorted.length} distinct, C+S combined):`);
  for (const [abbr, cnt] of sorted) console.log(`  ${abbr.padEnd(18)} : ${cnt}`);

  // ── 9. Spot-check: sample rows for a known company ────────────────────────────
  // Pick any company that has data — names are CSV-exact; fall through until one is found
  const targets = ['A B B India Ltd.', 'Varun Beverages Ltd.', 'Schaeffler India Ltd.', 'Reliance Industries Ltd.', 'Infosys Ltd.'];
  for (const target of targets) {
    const rows = finalRows.filter(r => r.company === target && r.source_type === 'C');
    if (!rows.length) continue;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Spot-check (C): ${target}  (${rows.length} KPI rows)`);
    console.log('─'.repeat(60));

    for (const abbr of ['REV_OP','PAT','EPS_BASIC','ASSET_PPE','DEBT_LT','CURR_LIAB','NET_WORTH','RES_SURPLUS','EMP_EXP','CFO','DEP_AMORT','ROE','CR','IC']) {
      const r = rows.find(x => x.kpi_abbr === abbr);
      if (r) {
        const display = (r.value / r.multiplier).toFixed(2);
        console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${display} Cr`);
      } else {
        console.log(`  ${abbr.padEnd(14)} — not found`);
      }
    }
    break;
  }

  // ── 10. EPS sanity check (must NOT be multiplied by 10M) ─────────────────────
  console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
  const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0 && r.source_type === 'C').slice(0, 5);
  if (epsSample.length) {
    for (const r of epsSample) {
      const ok = r.multiplier === 1 && r.unit === 'Rs';
      console.log(`  ${(ok ? '✓' : '✗')} ${r.company.slice(0, 35).padEnd(36)} EPS=${r.raw_value} Rs  stored=${r.value}  mult=${r.multiplier}`);
    }
  } else {
    console.log('  (no EPS rows found)');
  }

  // ── 11. Insert or stop ────────────────────────────────────────────────────────
  if (!DO_INSERT) {
    console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nEnsuring table ${TABLE_NAME}…`);
  await ensureTable();
  console.log('done.\n');

  if (DO_CLEAR) {
    console.log(`Clearing all rows from ${TABLE_NAME}…`);
    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE_NAME}`);
    console.log(`✓ Deleted ${deleted} rows.\n`);
  }

  console.log('Seeding PPE breakdown KPIs…');
  await seedPpeKpis();

  console.log(`Inserting ${finalRows.length} rows…`);
  await batchInsert(finalRows);

  // ── 12. Post-insert count from DB ────────────────────────────────────────────
  console.log('\nPost-insert row counts by source_type:');
  const dbCounts = await prisma.$queryRawUnsafe(
    `SELECT source_type, kpi_abbr, COUNT(*)::int AS cnt FROM ${TABLE_NAME} GROUP BY source_type, kpi_abbr ORDER BY source_type, cnt DESC`
  );
  let total = 0;
  let lastType = null;
  for (const r of dbCounts) {
    if (r.source_type !== lastType) { console.log(`\n  [${r.source_type}]`); lastType = r.source_type; }
    console.log(`    ${r.kpi_abbr.padEnd(18)} : ${r.cnt}`);
    total += r.cnt;
  }
  console.log(`\n  TOTAL : ${total}`);

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('\n✗ Error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
