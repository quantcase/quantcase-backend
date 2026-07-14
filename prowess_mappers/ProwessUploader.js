'use strict';

const fs   = require('fs');
const path = require('path');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

// ─── Shared unit constants ────────────────────────────────────────────────────

const CSV_UNIT_MAP = {
  'Rs. Crore':    'Cr',
  '(%)':          '%',
  '((%))':        '%',   // quarterly CSV variant
  'Times':        'x',
  'Indian Rupee': 'Rs',
};

const UNIT_MULTIPLIER = { Cr: 10_000_000, '%': 1, x: 1, Rs: 1 };

// ─── Annual — column maps ─────────────────────────────────────────────────────

const ANNUAL_BASE_COL_MAP = {
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
  'Net cash flow from operating activities':                                                  'CFO',
  'Net cash inflow or (outflow) from investing activities':                                   'CFI',
  'Net cash inflow or (outflow) from financing activities':                                   'CFF',
  // BFSI balance sheet
  'Working funds':                                                                            'WORKING_FUNDS',
};

const ANNUAL_OPTIONAL_COL_MAP = {
  // Cashflow — removed from 2026 consolidated; keep as fallback
  'Net cash inflow or (outflow) due to net increase or (decrease) in cash and cash equivalents': 'NET_CASH_CHANGE',
  // BFSI balance sheet — standalone-only in 2026 CSV
  'Deposits: Total':         'DEP_TOTAL',
  'Borrowings: Total':       'BORR_TOTAL',
  'Loan advances: Total':    'LOAN_ADV_TOTAL',
  'Investment at BV: Total': 'INV_BV_TOTAL',
  // Ratios
  'Return (cash) on capital employed':                          'ROCE',
  'Return on net worth (Return on Equity)':                     'ROE',
  'Current ratio (times)':                                      'CR',
  'Interest cover (times)':                                     'IC',
  'Capital employed':                                           'CAP_EMP',
  'Debt to equity ratio (times)':                               'DE',
  // PPE breakdown — Mar2025_annual.csv onwards
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

// REV_OP: first non-empty of these two mutually-exclusive columns wins
const ANNUAL_REV_OP_NON_FIN = 'Operating income for non-financial Cos.';
const ANNUAL_REV_OP_FIN     = 'Operating income for financial Cos.';

// DEP_AMORT priority chain — first non-empty wins (handles column renames across CSV vintages)
const ANNUAL_DEP_AMORT_COLS = [
  'Depreciation / Amortisation (net of transfer from revaluation reserves)',
  'Amortisation',
  'Non-cash charges',
];

const ANNUAL_SNAPSHOT_ABBRS = new Set([
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
  'EQ_SHARE_CAP', 'NET_WORTH',      'RES_SURPLUS',
  // BFSI
  'ASSET_GW',     'ASSET_INTANG',
  'DEP_TOTAL',    'BORR_TOTAL',     'LOAN_ADV_TOTAL', 'INV_BV_TOTAL', 'WORKING_FUNDS',
]);

const ANNUAL_STATEMENT_MAP = {
  TOTAL_INCOME: 'pnl', OTH_INC: 'pnl', TOTAL_COGS: 'pnl', COST_MAT: 'pnl',
  PURCH_STOCK:  'pnl', INV_CHG: 'pnl', TOTAL_OPEX: 'pnl', EMP_EXP:  'pnl',
  FIN_COST:     'pnl', DEP_AMORT:'pnl', OTH_EXP:   'pnl', PROV_CONT:'pnl',
  PBT_PRE_EXC:  'pnl', EXC_ITEMS:'pnl', PBT:       'pnl', TAX_EXP:  'pnl',
  PAT:          'pnl', EPS_BASIC:'pnl', EPS_DILUTED:'pnl', NIM_PCT:  'pnl',
  REV_OP:       'pnl',
  TOTAL_ASSETS: 'balance_sheet', NONCURR_ASSETS: 'balance_sheet', ASSET_PPE:      'balance_sheet',
  ASSET_CWIP:   'balance_sheet', INV_NONCURR:    'balance_sheet', LOANS_NONCURR:  'balance_sheet',
  OTH_ASSET_NC: 'balance_sheet', BANK_BAL_OTHER: 'balance_sheet', CURR_ASSETS:    'balance_sheet',
  INVENTORY:    'balance_sheet', INV_CURR:        'balance_sheet', TRADE_RECV:     'balance_sheet',
  CASH_EQUIV:   'balance_sheet', LOANS_CURR:      'balance_sheet', TOTAL_LIAB:     'balance_sheet',
  NONCURR_LIAB: 'balance_sheet', DEBT_LT:         'balance_sheet', DTL:            'balance_sheet',
  PROV_LT:      'balance_sheet', CURR_LIAB:       'balance_sheet', DEBT_ST:        'balance_sheet',
  TRADE_PAY:    'balance_sheet', OTH_LIAB_CURR:   'balance_sheet', PROV_ST:        'balance_sheet',
  EQ_SHARE_CAP: 'balance_sheet', NET_WORTH:        'balance_sheet', RES_SURPLUS:   'balance_sheet',
  ASSET_GW:     'balance_sheet', ASSET_INTANG:     'balance_sheet', DEP_TOTAL:     'balance_sheet',
  BORR_TOTAL:   'balance_sheet', LOAN_ADV_TOTAL:   'balance_sheet', INV_BV_TOTAL:  'balance_sheet',
  WORKING_FUNDS:'balance_sheet',
  ASSET_LAND_NET:    'balance_sheet', ASSET_MINING_NET:   'balance_sheet', ASSET_BIO_NET:       'balance_sheet',
  ASSET_LEASE_IMP_NET:'balance_sheet',ASSET_BLDG_NET:    'balance_sheet', ASSET_LAND_GRS:      'balance_sheet',
  ASSET_PM_NET:      'balance_sheet', ASSET_IT_NET:       'balance_sheet', ASSET_ELEC_NET:      'balance_sheet',
  ASSET_PM_GRS:      'balance_sheet', ASSET_TRANS_NET:    'balance_sheet', ASSET_FURN_NET:      'balance_sheet',
  CFO: 'cashflow', CFI: 'cashflow', CFF: 'cashflow', NET_CASH_CHANGE: 'cashflow',
};

const ANNUAL_PPE_KPIS = [
  { abbr: 'ASSET_LAND_NET',      full_form: 'Net Land and Buildings (incl. Bearer Plants)',                        kpi_type: 'assets' },
  { abbr: 'ASSET_MINING_NET',    full_form: 'Net Mining / Oil & Gas Properties',                                   kpi_type: 'assets' },
  { abbr: 'ASSET_BIO_NET',       full_form: 'Net Biological Assets – Bearer Plants',                               kpi_type: 'assets' },
  { abbr: 'ASSET_LEASE_IMP_NET', full_form: 'Net Leasehold Improvements',                                          kpi_type: 'assets' },
  { abbr: 'ASSET_BLDG_NET',      full_form: 'Net Buildings',                                                       kpi_type: 'assets' },
  { abbr: 'ASSET_LAND_GRS',      full_form: 'Gross Land and Buildings (incl. Bearer Plants)',                      kpi_type: 'assets' },
  { abbr: 'ASSET_PM_NET',        full_form: 'Net Plant & Machinery, Computers and Electrical Installations',       kpi_type: 'assets' },
  { abbr: 'ASSET_IT_NET',        full_form: 'Net Computers and IT Systems',                                        kpi_type: 'assets' },
  { abbr: 'ASSET_ELEC_NET',      full_form: 'Net Electrical Installations & Fittings',                             kpi_type: 'assets' },
  { abbr: 'ASSET_PM_GRS',        full_form: 'Gross Plant & Machinery, Computers and Electrical Installations',     kpi_type: 'assets' },
  { abbr: 'ASSET_TRANS_NET',     full_form: 'Net Transport & Communication Equipment and Infrastructure',          kpi_type: 'assets' },
  { abbr: 'ASSET_FURN_NET',      full_form: 'Net Furniture and Other Fixed Assets',                                kpi_type: 'assets' },
];

// ─── Quarterly — column maps ──────────────────────────────────────────────────

const QTR_COL_MAP = {
  'Total income from continuing operations':                                                          'TOTAL_INCOME',
  'Net sales':                                                                                        'REV_OP',
  'Change in stock':                                                                                  'INV_CHG',
  'Raw materials, stocks, spares, purchase of finished goods':                                        'COST_MAT',
  'Salaries and wages':                                                                               'EMP_EXP',
  'Total other expenses':                                                                             'OTH_EXP',
  'Interest expenses':                                                                                'FIN_COST',
  'Depreciation':                                                                                     'DEP_AMORT',
  'Provisions and contingencies':                                                                     'PROV_CONT',
  'Net Profit/(Loss) for the period from continuing operations (after tax)':                          'PAT',
  'Paid up capital':                                                                                  'EQ_SHARE_CAP',
  'Reserves':                                                                                         'RES_SURPLUS',
  'Earnings per share before extraordinary item':                                                     'EPS_BASIC',
  'Diluted earnings per share before extraordinary item':                                             'EPS_DILUTED',
  'Borrowings':                                                                                       'BORR_TOTAL',
  'Current liabilities':                                                                              'CURR_LIAB',
  'Long term provisions':                                                                             'PROV_LT',
  'Short term provisions':                                                                            'PROV_ST',
  'Deferred tax liability':                                                                           'DTL',
  'Net fixed assets':                                                                                 'ASSET_PPE',
  'Capital work in progress':                                                                         'ASSET_CWIP',
  'Long term investments':                                                                            'INV_NONCURR',
  'Short term investments':                                                                           'INV_CURR',
  'Other non-current assets':                                                                         'OTH_ASSET_NC',
  'Current assets & loans and advances':                                                              'CURR_ASSETS',
  // Insurance CFO (direct method) — empty for non-insurance companies
  'Net cash inflow or (outflow) from operating activities - Direct method (For insurance cos.)':      'CFO',
  'Net cash inflow or (outflow) from investing activities':                                           'CFI',
  'Net cash inflow or (outflow) from financing activities':                                           'CFF',
  'Cash and cash equivalents as at the end of the period':                                           'CASH_EQUIV',
  'Net Interest Margin':                                                                              'NIM_PCT',
  'Total outstanding AUM':                                                                            'AUM_TOTAL',
  'Total expenses':                                                                                   'TOTAL_OPEX',
  'Other income':                                                                                     'OTH_INC',
};

const QTR_SNAPSHOT_ABBRS = new Set([
  'EQ_SHARE_CAP', 'RES_SURPLUS',
  'BORR_TOTAL', 'CURR_LIAB', 'PROV_LT', 'PROV_ST', 'DTL',
  'ASSET_PPE', 'ASSET_CWIP', 'INV_NONCURR', 'INV_CURR', 'OTH_ASSET_NC', 'CURR_ASSETS',
  'CASH_EQUIV', 'AUM_TOTAL',
]);

const QTR_STATEMENT_MAP = {
  TOTAL_INCOME: 'pnl', REV_OP: 'pnl', OTH_INC: 'pnl',
  INV_CHG:      'pnl', COST_MAT: 'pnl', EMP_EXP: 'pnl',
  OTH_EXP:      'pnl', FIN_COST: 'pnl', DEP_AMORT: 'pnl',
  PROV_CONT:    'pnl', PAT: 'pnl', TOTAL_OPEX: 'pnl',
  EPS_BASIC:    'pnl', EPS_DILUTED: 'pnl', NIM_PCT: 'pnl',
  EQ_SHARE_CAP: 'balance_sheet', RES_SURPLUS:  'balance_sheet',
  BORR_TOTAL:   'balance_sheet', CURR_LIAB:    'balance_sheet',
  PROV_LT:      'balance_sheet', PROV_ST:      'balance_sheet',
  DTL:          'balance_sheet', ASSET_PPE:    'balance_sheet',
  ASSET_CWIP:   'balance_sheet', INV_NONCURR:  'balance_sheet',
  INV_CURR:     'balance_sheet', OTH_ASSET_NC: 'balance_sheet',
  CURR_ASSETS:  'balance_sheet', CASH_EQUIV:   'balance_sheet',
  AUM_TOTAL:    'balance_sheet',
  CFO: 'cashflow', CFI: 'cashflow', CFF: 'cashflow',
};

// Indian FY: Apr–Mar. fyOffset added to label year to get FY year.
const QTR_MONTH_META = {
  Mar: { quarter: 'Q4', fyOffset: 0, startMon: '01' },
  Jun: { quarter: 'Q1', fyOffset: 1, startMon: '04' },
  Sep: { quarter: 'Q2', fyOffset: 1, startMon: '07' },
  Dec: { quarter: 'Q3', fyOffset: 1, startMon: '10' },
};

// ─── ProwessUploader ──────────────────────────────────────────────────────────

class ProwessUploader {
  /**
   * @param {object} opts
   * @param {string} opts.table          - Target DB table (e.g. 'prowess_values_new')
   * @param {string} opts.csvPath        - Absolute path to the CSV file
   * @param {boolean} opts.doInsert      - Write to DB if true; verify-only if false
   * @param {boolean} opts.doClear       - Delete existing rows before insert
   * @param {string}  [opts.constraintName] - UNIQUE constraint name (defaults to <table>_call_kpi_unique)
   * @param {number}  [opts.rowLimit]        - Cap data rows processed (for smoke-testing)
   */
  constructor({ table, csvPath, doInsert, doClear, constraintName, rowLimit }) {
    this.table          = table;
    this.csvPath        = csvPath;
    this.doInsert       = doInsert;
    this.doClear        = doClear;
    this.rowLimit       = rowLimit ?? Infinity;
    this._constraint    = constraintName ?? `${table}_call_kpi_unique`;
    this._idxPrefix     = this._constraint.replace('_call_kpi_unique', '');
    this.prisma         = new PrismaClient();
  }

  // ─── Shared helpers ───────────────────────────────────────────────────────────

  normalizeName(name) {
    return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_')
      .replace(/^_|_$/g, '').slice(0, 50);
  }

  /** ISO end date of a 12-month period → ISO start date (day after same date one year prior). */
  startOfPeriod(endIso) {
    if (!endIso) return null;
    const d = new Date(endIso);
    d.setFullYear(d.getFullYear() - 1);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Build { columnName → absoluteIndex } for a range of headers.
   * First occurrence wins when the same name appears multiple times.
   */
  buildColMap(headers, startIdx = 0, endIdx) {
    const end = endIdx ?? headers.length - 1;
    const map = {};
    for (let i = startIdx; i <= end; i++) {
      const h = (headers[i] || '').trim();
      if (h && !(h in map)) map[h] = i;
    }
    return map;
  }

  /** Remove duplicate (callId, kpi_abbr) pairs — first occurrence wins. */
  deduplicateRows(allRows) {
    const seen = new Set();
    const out  = [];
    for (const row of allRows) {
      const key = `${row.callId}|${row.kpi_abbr}`;
      if (!seen.has(key)) { seen.add(key); out.push(row); }
    }
    return out;
  }

  /**
   * Resolve CSV header names not covered by the hardcoded column maps against
   * the `kpis` table (exact match on `abbr` or `prowess_name`), so new
   * quarterly/annual indicators can be onboarded via the admin flow (create a
   * Kpi row + prowess_name) without a code deploy. Returns the extra
   * { headerName → kpi_abbr } entries to merge into the normal column map,
   * plus the headers that still have no home (candidates for a new Kpi).
   */
  async resolveDynamicIndicators(headers, knownNames) {
    const candidates = [...new Set(
      headers.map(h => (h || '').trim()).filter(h => h && !knownNames.has(h))
    )];
    if (!candidates.length) return { dynamicMap: {}, unmatched: [] };

    const matches = await this.prisma.kpi.findMany({
      where: { OR: [{ abbr: { in: candidates } }, { prowess_name: { in: candidates } }] },
      select: { abbr: true, prowess_name: true },
    });

    const dynamicMap = {};
    for (const kpi of matches) {
      if (candidates.includes(kpi.abbr))         dynamicMap[kpi.abbr] = kpi.abbr;
      if (kpi.prowess_name && candidates.includes(kpi.prowess_name)) dynamicMap[kpi.prowess_name] = kpi.abbr;
    }
    const unmatched = candidates.filter(c => !(c in dynamicMap));
    return { dynamicMap, unmatched };
  }

  async batchInsert(rows, batchSize = 500) {
    const { table, _constraint } = this;
    const [{ n: before }] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${table}`);
    let attempted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch  = rows.slice(i, i + batchSize);
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
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ${table} (
           id, call_id, company, fiscal_year, quarter, call_date,
           kpi_abbr, value, raw_value, unit, multiplier,
           start_date, end_date, period_type, source, source_path,
           statement, created_at, updated_at, source_type
         ) VALUES ${placeholders.join(',\n')}
         ON CONFLICT (call_id, kpi_abbr) DO NOTHING`,
        ...params
      );
      attempted += batch.length;
      process.stdout.write(`  Progress: ${attempted}/${rows.length}\r`);
    }

    const [{ n: after }] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${table}`);
    const inserted = after - before;
    console.log(`\n✓ Attempted ${attempted} rows — ${inserted} inserted (${attempted - inserted} skipped as duplicates)`);
    return { attempted, inserted, skipped: attempted - inserted };
  }

  async ensureTable() {
    const { table, _constraint, _idxPrefix: p } = this;

    // Skip all DDL if table is already present — avoids timeout on large live tables.
    const existing = await this.prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'`
    );
    if (existing.length > 0) {
      console.log(`  (${table} already exists — skipping DDL)`);
      return;
    }

    // First-time setup only
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE ${table} (LIKE kpi_values INCLUDING DEFAULTS)`
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE ${table} ADD CONSTRAINT ${_constraint} UNIQUE (call_id, kpi_abbr)`
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE ${table} ADD COLUMN source_type VARCHAR(1) NOT NULL DEFAULT 'C'`
    );
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_call_id         ON ${table} (call_id)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_company_fy_q    ON ${table} (company, fiscal_year, quarter)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_company_kpi     ON ${table} (company, kpi_abbr)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_kpi             ON ${table} (kpi_abbr)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_kpi_period      ON ${table} (kpi_abbr, period_type)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX idx_${p}_company_srctype ON ${table} (company, source_type)`);
  }

  // ─── Annual mode ──────────────────────────────────────────────────────────────

  /** "Mar 2026" → { endDate: '2026-03-31', fiscalYear: 'FY2026' } */
  parseYearLabel(label) {
    const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
    const [mon, yr] = (label || '').trim().split(' ');
    const mm = MON[mon];
    if (!mm || !yr) return null;
    const lastDay = new Date(parseInt(yr), parseInt(mm), 0).getDate();
    return {
      endDate:    `${yr}-${mm}-${String(lastDay).padStart(2, '0')}`,
      fiscalYear: `FY${yr}`,
    };
  }

  /**
   * Split the header row into consolidated and standalone section maps.
   * Searches for "Standalone" in sectionRow (row 2) to find the split point.
   */
  buildSectionColMaps(headers, sectionRow) {
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

  /** Extract KPI rows from one section (C or S) and push into allRows. */
  processAnnualSection(dataRow, company, sectionColMap, yearInfo, sourceType, colUnitByIdx, allRows, extraMap = {}) {
    const { endDate, fiscalYear } = yearInfo;
    const startDate = this.startOfPeriod(endDate);
    const callId    = `prowess_new_${this.normalizeName(company)}_${fiscalYear}_${sourceType}`;

    const pushRow = (colName, abbr) => {
      const idx = sectionColMap[colName];
      if (idx == null) return;
      const raw = (dataRow[idx] || '').trim();
      if (!raw) return;
      const num = parseFloat(raw);
      if (isNaN(num)) return;

      const unit   = colUnitByIdx[idx] ?? 'Cr';
      const mult   = UNIT_MULTIPLIER[unit] ?? 1;
      const isSnap = ANNUAL_SNAPSHOT_ABBRS.has(abbr);

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
        source_path: `prowess/${path.basename(this.csvPath)}`,
        statement:   ANNUAL_STATEMENT_MAP[abbr] ?? null,
      });
    };

    // REV_OP: first non-empty of two mutually-exclusive operating income columns
    const nonFinRaw = (dataRow[sectionColMap[ANNUAL_REV_OP_NON_FIN]] || '').trim();
    const finRaw    = (dataRow[sectionColMap[ANNUAL_REV_OP_FIN]]     || '').trim();
    if (nonFinRaw || finRaw) pushRow(nonFinRaw ? ANNUAL_REV_OP_NON_FIN : ANNUAL_REV_OP_FIN, 'REV_OP');

    for (const [colName, abbr] of Object.entries(ANNUAL_BASE_COL_MAP))     pushRow(colName, abbr);
    for (const [colName, abbr] of Object.entries(ANNUAL_OPTIONAL_COL_MAP)) {
      if (colName in sectionColMap) pushRow(colName, abbr);
    }
    // Indicators resolved dynamically against kpis.abbr/prowess_name (admin-added).
    for (const [colName, abbr] of Object.entries(extraMap)) {
      if (colName in sectionColMap) pushRow(colName, abbr);
    }

    // DEP_AMORT: first non-empty column in priority chain wins
    for (const colName of ANNUAL_DEP_AMORT_COLS) {
      const idx = sectionColMap[colName];
      if (idx != null && (dataRow[idx] || '').trim()) { pushRow(colName, 'DEP_AMORT'); break; }
    }
  }

  async seedAnnualPpeKpis() {
    let created = 0, skipped = 0;
    for (const kpi of ANNUAL_PPE_KPIS) {
      const existing = await this.prisma.kpi.findFirst({ where: { abbr: kpi.abbr } });
      if (existing) { skipped++; continue; }
      await this.prisma.kpi.create({
        data: { abbr: kpi.abbr, full_form: kpi.full_form, kpi_type: kpi.kpi_type,
                denomination: 'rupee', industry: [], source: 'QE' },
      });
      created++;
    }
    console.log(`✓ KPI seed: ${created} created, ${skipped} already existed`);
  }

  async runAnnual() {
    const { table, csvPath, doInsert, doClear } = this;
    console.log(`=== ProwessUploader (annual) → ${table} ===`);
    console.log(doInsert ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write to DB]\n');

    // 1. Parse CSV
    console.log('Parsing CSV…');
    const records    = parse(fs.readFileSync(csvPath), { bom: true, relax_column_count: true });
    const sectionRow = records[2];
    const unitRow    = records[3];
    const yearRow    = records[4];
    const headers    = records[5];
    const dataRows   = records.slice(6).filter(r => (r[0] || '').trim()).slice(0, this.rowLimit);

    console.log(`  Companies : ${dataRows.length}${this.rowLimit < Infinity ? ` (limited to ${this.rowLimit})` : ''}`);
    console.log(`  Columns   : ${headers.length}`);

    // 2. Build per-section column maps
    const { consMap, stanMap, stanStart } = this.buildSectionColMaps(headers, sectionRow);
    console.log(`  Consolidated cols : ${Object.keys(consMap).length}  (cols 1–${stanStart - 1})`);
    console.log(`  Standalone cols   : ${Object.keys(stanMap).length}  (cols ${stanStart}–${headers.length - 1})`);

    // 3. Parse year label for each section
    const consFirstIdx = Object.values(consMap)[0];
    const consYearInfo = this.parseYearLabel((yearRow[consFirstIdx] || '').trim());
    const stanYearInfo = stanStart ? this.parseYearLabel((yearRow[stanStart] || '').trim()) : null;

    if (!consYearInfo) throw new Error(`Could not parse consolidated year label: "${yearRow[consFirstIdx]}"`);
    console.log(`  Consolidated year : ${consYearInfo.fiscalYear} (end ${consYearInfo.endDate})`);
    if (stanYearInfo) console.log(`  Standalone year   : ${stanYearInfo.fiscalYear} (end ${stanYearInfo.endDate})`);

    // 4. Validate all required columns exist in consolidated section
    const requiredCols = [...Object.keys(ANNUAL_BASE_COL_MAP), ANNUAL_REV_OP_NON_FIN, ANNUAL_REV_OP_FIN];
    const consMissing  = requiredCols.filter(n => !(n in consMap));
    if (consMissing.length) {
      throw new Error(
        `Consolidated section missing ${consMissing.length} column(s):\n` +
        consMissing.map(c => `  ✗ "${c}"`).join('\n')
      );
    }
    console.log(`\n✓ All ${requiredCols.length} expected columns found in consolidated section.\n`);

    // 4b. Resolve any remaining columns dynamically against kpis.abbr/prowess_name
    // (covers new indicators the admin has onboarded via the Kpi admin endpoint).
    const knownNames = new Set([
      ...Object.keys(ANNUAL_BASE_COL_MAP), ...Object.keys(ANNUAL_OPTIONAL_COL_MAP),
      ANNUAL_REV_OP_NON_FIN, ANNUAL_REV_OP_FIN, ...ANNUAL_DEP_AMORT_COLS,
    ]);
    const { dynamicMap, unmatched } = await this.resolveDynamicIndicators(headers.slice(1), knownNames);
    if (Object.keys(dynamicMap).length) {
      console.log(`✓ Dynamically matched ${Object.keys(dynamicMap).length} extra column(s) via kpis table:`);
      for (const [colName, abbr] of Object.entries(dynamicMap)) console.log(`  "${colName}" → ${abbr}`);
    }
    if (unmatched.length) {
      console.log(`⚠ ${unmatched.length} column(s) have no KPI mapping (create a Kpi with matching prowess_name to include them):`);
      for (const c of unmatched) console.log(`  ✗ "${c}"`);
    }

    // 5. Unit lookup by absolute column index
    const colUnitByIdx = {};
    for (let i = 0; i < headers.length; i++) {
      const raw = (unitRow[i] || '').trim();
      colUnitByIdx[i] = CSV_UNIT_MAP[raw] ?? null;
    }

    // 6. Build all rows
    console.log('Building rows…');
    const allRows = [];
    for (const dataRow of dataRows) {
      const company = (dataRow[0] || '').trim();
      if (!company) continue;
      this.processAnnualSection(dataRow, company, consMap, consYearInfo, 'C', colUnitByIdx, allRows, dynamicMap);
      if (stanYearInfo && stanStart) {
        this.processAnnualSection(dataRow, company, stanMap, stanYearInfo, 'S', colUnitByIdx, allRows, dynamicMap);
      }
    }
    const finalRows = this.deduplicateRows(allRows);

    // 7. Verification stats
    console.log(`\n${'─'.repeat(60)}`);
    console.log('VERIFICATION');
    console.log('─'.repeat(60));
    const cRows = finalRows.filter(r => r.source_type === 'C');
    const sRows = finalRows.filter(r => r.source_type === 'S');
    console.log(`Total rows : ${finalRows.length}  (C=${cRows.length}, S=${sRows.length})`);

    const countByAbbr = {};
    for (const r of finalRows) countByAbbr[r.kpi_abbr] = (countByAbbr[r.kpi_abbr] || 0) + 1;
    console.log(`\nRows per KPI (${Object.keys(countByAbbr).length} distinct):`);
    for (const [abbr, cnt] of Object.entries(countByAbbr).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${abbr.padEnd(18)} : ${cnt}`);
    }

    // 8. Spot-check a known company
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
          console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${(r.value / r.multiplier).toFixed(2)}`);
        } else {
          console.log(`  ${abbr.padEnd(14)} — not found`);
        }
      }
      break;
    }

    // 9. EPS sanity check
    console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
    const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0 && r.source_type === 'C').slice(0, 5);
    if (epsSample.length) {
      for (const r of epsSample) {
        const ok = r.multiplier === 1 && r.unit === 'Rs';
        console.log(`  ${ok ? '✓' : '✗'} ${r.company.slice(0, 35).padEnd(36)} EPS=${r.raw_value} Rs  stored=${r.value}  mult=${r.multiplier}`);
      }
    } else {
      console.log('  (no EPS rows found)');
    }

    const report = {
      mode: 'annual', table, inserted: false,
      companiesInCsv: dataRows.length, columnsInCsv: headers.length,
      consolidatedYear: consYearInfo.fiscalYear, standaloneYear: stanYearInfo?.fiscalYear ?? null,
      dynamicIndicatorsMatched: dynamicMap, unmatchedColumns: unmatched,
      totalRows: finalRows.length, rowsBySourceType: { C: cRows.length, S: sRows.length },
      rowsByKpi: countByAbbr,
    };

    if (!doInsert) {
      console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
      return report;
    }

    // 10. DB writes
    console.log(`\nEnsuring table ${table}…`);
    await this.ensureTable();
    console.log('done.\n');

    if (doClear) {
      const deleted = await this.prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
      console.log(`✓ Cleared ${deleted} rows from ${table}.\n`);
    }

    console.log('Seeding PPE breakdown KPIs…');
    await this.seedAnnualPpeKpis();

    console.log(`Inserting ${finalRows.length} rows…`);
    const insertStats = await this.batchInsert(finalRows);

    // 11. Post-insert counts
    console.log('\nPost-insert row counts by source_type:');
    const dbCounts = await this.prisma.$queryRawUnsafe(
      `SELECT source_type, kpi_abbr, COUNT(*)::int AS cnt FROM ${table} GROUP BY source_type, kpi_abbr ORDER BY source_type, cnt DESC`
    );
    let total = 0, lastType = null;
    for (const r of dbCounts) {
      if (r.source_type !== lastType) { console.log(`\n  [${r.source_type}]`); lastType = r.source_type; }
      console.log(`    ${r.kpi_abbr.padEnd(18)} : ${r.cnt}`);
      total += r.cnt;
    }
    console.log(`\n  TOTAL : ${total}`);

    return { ...report, inserted: true, insertStats };
  }

  // ─── Quarterly mode ───────────────────────────────────────────────────────────

  /** "Mar 2025" → { quarter, fiscalYear, endDate, startDate } */
  parseQuarterLabel(label) {
    const [mon, yr] = (label || '').trim().split(' ');
    const meta = QTR_MONTH_META[mon];
    if (!meta || !yr) return null;
    const year   = parseInt(yr, 10);
    const endMon = { Mar:'03', Jun:'06', Sep:'09', Dec:'12' }[mon];
    const lastDay = new Date(year, parseInt(endMon, 10), 0).getDate();
    return {
      quarter:    meta.quarter,
      fiscalYear: `FY${year + meta.fyOffset}`,
      endDate:    `${year}-${endMon}-${String(lastDay).padStart(2, '0')}`,
      startDate:  `${year}-${meta.startMon}-01`,
    };
  }

  /** Detect quarter blocks from row 4 by label-change boundaries. */
  detectQuarterBlocks(yearRow) {
    const blocks = [];
    let cur = null;
    for (let i = 1; i < yearRow.length; i++) {
      const lbl = (yearRow[i] || '').trim();
      if (!lbl) continue;
      if (!cur || cur.label !== lbl) { cur = { label: lbl, start: i, end: i }; blocks.push(cur); }
      else cur.end = i;
    }
    return blocks;
  }

  async runQuarterly() {
    const { table, csvPath, doInsert, doClear } = this;
    console.log(`=== ProwessUploader (quarterly) → ${table} ===`);
    console.log(doInsert ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write]\n');

    // 1. Parse CSV
    console.log('Parsing CSV…');
    const records = parse(fs.readFileSync(csvPath), { bom: true, relax_column_count: true });
    const unitRow  = records[3];
    const yearRow  = records[4];
    const headers  = records[5];
    const dataRows = records.slice(6).filter(r => (r[0] || '').trim()).slice(0, this.rowLimit);

    console.log(`  Companies : ${dataRows.length}${this.rowLimit < Infinity ? ` (limited to ${this.rowLimit})` : ''}`);
    console.log(`  Columns   : ${headers.length}`);

    const sectionLabel = (records[2][1] || '').trim();
    if (!sectionLabel.toLowerCase().includes('standalone')) {
      console.warn(`  WARNING: expected "Standalone" in row 2, got: "${sectionLabel}"`);
    }

    // 2. Detect quarter blocks and parse their labels
    const blocks = this.detectQuarterBlocks(yearRow);
    if (!blocks.length) throw new Error('No quarter blocks found in row 4.');
    for (const b of blocks) {
      b.info = this.parseQuarterLabel(b.label);
      if (!b.info) throw new Error(`Cannot parse quarter label: "${b.label}"`);
    }
    console.log(`  Quarters  : ${blocks.length} (${blocks.map(b => b.label).join(', ')})`);

    // 3. Unit lookup + per-block column maps
    const colUnitByIdx = {};
    for (let i = 0; i < unitRow.length; i++) {
      colUnitByIdx[i] = CSV_UNIT_MAP[(unitRow[i] || '').trim()] ?? null;
    }
    for (const b of blocks) b.colMap = this.buildColMap(headers, b.start, b.end);

    // 4. Validate all mapped columns exist in first block
    const missing = Object.keys(QTR_COL_MAP).filter(n => !(n in blocks[0].colMap));
    if (missing.length) {
      throw new Error(
        `First quarter block missing ${missing.length} mapped column(s):\n` +
        missing.map(c => `  ✗ "${c}"`).join('\n')
      );
    }
    console.log(`\n✓ All ${Object.keys(QTR_COL_MAP).length} mapped columns found in first block.\n`);

    // 4b. Resolve any remaining columns (first block) dynamically against
    // kpis.abbr/prowess_name (covers indicators onboarded via the admin flow).
    const knownNames = new Set(Object.keys(QTR_COL_MAP));
    const firstBlockHeaders = Object.keys(blocks[0].colMap);
    const { dynamicMap, unmatched } = await this.resolveDynamicIndicators(firstBlockHeaders, knownNames);
    if (Object.keys(dynamicMap).length) {
      console.log(`✓ Dynamically matched ${Object.keys(dynamicMap).length} extra column(s) via kpis table:`);
      for (const [colName, abbr] of Object.entries(dynamicMap)) console.log(`  "${colName}" → ${abbr}`);
    }
    if (unmatched.length) {
      console.log(`⚠ ${unmatched.length} column(s) have no KPI mapping (create a Kpi with matching prowess_name to include them):`);
      for (const c of unmatched) console.log(`  ✗ "${c}"`);
    }
    const effectiveColMap = { ...QTR_COL_MAP, ...dynamicMap };

    // 5. Build all rows
    console.log('Building rows…');
    const allRows = [];
    for (const dataRow of dataRows) {
      const company = (dataRow[0] || '').trim();
      if (!company) continue;

      for (const block of blocks) {
        const { quarter, fiscalYear, endDate, startDate } = block.info;

        // Skip block if company has no data in it at all
        const hasAny = Object.values(block.colMap).some(idx => (dataRow[idx] || '').trim());
        if (!hasAny) continue;

        const callId = `prowess_qtr_${this.normalizeName(company)}_${fiscalYear}_${quarter}_S`;

        for (const [colName, abbr] of Object.entries(effectiveColMap)) {
          const idx = block.colMap[colName];
          if (idx == null) continue;
          const raw = (dataRow[idx] || '').trim();
          if (!raw) continue;
          const num = parseFloat(raw);
          if (isNaN(num)) continue;

          const unit   = colUnitByIdx[idx] ?? 'Cr';
          const mult   = UNIT_MULTIPLIER[unit] ?? 1;
          const isSnap = QTR_SNAPSHOT_ABBRS.has(abbr);

          allRows.push({
            callId, company, source_type: 'S',
            fiscal_year: fiscalYear, quarter, call_date: endDate,
            kpi_abbr:    abbr,
            value:       parseFloat((num * mult).toFixed(4)),
            raw_value:   raw, unit, multiplier: mult,
            start_date:  isSnap ? null : startDate,
            end_date:    endDate,
            period_type: isSnap ? 'snapshot' : 'quarterly',
            source:      'QE',
            source_path: `prowess/${path.basename(csvPath)}`,
            statement:   QTR_STATEMENT_MAP[abbr] ?? null,
          });
        }
      }
    }
    const finalRows = this.deduplicateRows(allRows);

    // 6. Verification stats
    console.log(`\n${'─'.repeat(60)}`);
    console.log('VERIFICATION');
    console.log('─'.repeat(60));
    console.log(`Total rows built : ${finalRows.length}`);

    const byQtr = {};
    for (const r of finalRows) {
      const k = `${r.quarter} ${r.fiscal_year}`;
      byQtr[k] = (byQtr[k] || 0) + 1;
    }
    console.log('\nRows per quarter:');
    for (const [k, n] of Object.entries(byQtr)) console.log(`  ${k.padEnd(12)} : ${n}`);

    const byAbbr = {};
    for (const r of finalRows) byAbbr[r.kpi_abbr] = (byAbbr[r.kpi_abbr] || 0) + 1;
    console.log(`\nRows per KPI (${Object.keys(byAbbr).length} distinct):`);
    for (const [abbr, cnt] of Object.entries(byAbbr).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${abbr.padEnd(18)} : ${cnt}`);
    }

    // 7. Spot-check a known company
    const targets = ['Reliance Industries Ltd.', 'Infosys Ltd.', 'Tata Consultancy Services Ltd.',
                     '20 Microns Ltd.', 'A B B India Ltd.'];
    for (const target of targets) {
      const rows = finalRows.filter(r => r.company === target);
      if (!rows.length) continue;
      const quarters = [...new Set(rows.map(r => `${r.quarter} ${r.fiscal_year}`))].sort();
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Spot-check: ${target}  (${rows.length} rows, ${quarters.length} quarters)`);
      console.log('─'.repeat(60));
      const [q, fy] = quarters[0].split(' ');
      const qRows = rows.filter(r => r.quarter === q && r.fiscal_year === fy);
      for (const abbr of ['REV_OP','PAT','EPS_BASIC','EPS_DILUTED','ASSET_PPE','CURR_LIAB','BORR_TOTAL','CFO','DEP_AMORT','OTH_INC']) {
        const r = qRows.find(x => x.kpi_abbr === abbr);
        if (r) {
          console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${(r.value / r.multiplier).toFixed(2)}  period=${r.period_type}`);
        } else {
          console.log(`  ${abbr.padEnd(14)} — not found`);
        }
      }
      break;
    }

    // 8. EPS sanity check
    console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
    const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0).slice(0, 5);
    for (const r of epsSample) {
      const ok = r.multiplier === 1 && r.unit === 'Rs';
      console.log(`  ${ok ? '✓' : '✗'} ${r.company.slice(0, 35).padEnd(36)} EPS=${r.raw_value}  stored=${r.value}  mult=${r.multiplier}  unit=${r.unit}`);
    }

    const report = {
      mode: 'quarterly', table, inserted: false,
      companiesInCsv: dataRows.length, columnsInCsv: headers.length,
      quarters: blocks.map(b => b.label),
      dynamicIndicatorsMatched: dynamicMap, unmatchedColumns: unmatched,
      totalRows: finalRows.length, rowsByQuarter: byQtr, rowsByKpi: byAbbr,
    };

    if (!doInsert) {
      console.log('\n[VERIFY ONLY] No DB writes. Re-run with --insert to load into DB.\n');
      return report;
    }

    // 9. DB writes
    console.log(`\nEnsuring table ${table}…`);
    await this.ensureTable();
    console.log('done.\n');

    if (doClear) {
      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE period_type = 'quarterly'`
      );
      console.log(`✓ Cleared ${deleted} quarterly rows from ${table}.\n`);
    }

    console.log(`Inserting ${finalRows.length} rows…`);
    const insertStats = await this.batchInsert(finalRows);

    // 10. Post-insert counts
    console.log('\nPost-insert quarterly row counts by quarter:');
    const dbCounts = await this.prisma.$queryRawUnsafe(
      `SELECT fiscal_year, quarter, COUNT(*)::int AS cnt
       FROM ${table} WHERE period_type = 'quarterly'
       GROUP BY fiscal_year, quarter ORDER BY fiscal_year, quarter`
    );
    let total = 0;
    for (const r of dbCounts) {
      console.log(`  ${r.quarter} ${r.fiscal_year} : ${r.cnt}`);
      total += r.cnt;
    }
    console.log(`  TOTAL       : ${total}`);

    return { ...report, inserted: true, insertStats };
  }

  // ─── Entry point ──────────────────────────────────────────────────────────────

  async run(mode) {
    try {
      if (mode === 'annual')         return await this.runAnnual();
      else if (mode === 'quarterly') return await this.runQuarterly();
      else throw new Error(`Unknown mode "${mode}". Use 'annual' or 'quarterly'.`);
    } finally {
      await this.prisma.$disconnect();
    }
  }
}

module.exports = { ProwessUploader };
