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
  'CA':           'x',
  'Nos':          'x',
};

const UNIT_MULTIPLIER = { Cr: 10_000_000, '%': 1, x: 1, Rs: 1 };

// ─── Annual — column maps ─────────────────────────────────────────────────────
//
// There used to be a hardcoded CSV-header -> abbr map here (ANNUAL_BASE_COL_MAP
// / ANNUAL_OPTIONAL_COL_MAP). It's gone -- every annual column now resolves
// purely dynamically against kpis.abbr/kpis.prowess_name (see runAnnual's
// resolveDynamicIndicators call, knownNames now always empty for annual).
// Admin owns the full mapping via the Kpi table (prowess_name = exact CSV
// header text), can see/edit it directly, and nothing here needs a code
// deploy to change a mapping or add a new one.
//
// The snapshot/flow start_date distinction (ANNUAL_SNAPSHOT_ABBRS) is gone
// too -- every annual row now gets a real start_date and period_type:
// 'annual', no more null-start_date "snapshot" rows. That distinction used to
// cause a real bug: dataFetcherCore.js's _fetchPeriodBoundaries needed a
// DISTINCT ON + ORDER BY start_date (NULLS LAST) workaround because a plain
// Prisma distinct() could land on a null-start_date snapshot row first for a
// given period, silently nulling PB_TTM/MCAP_SALES/PE_DAILY on some quarters.
// With every row carrying a real start_date, that workaround is now simply
// redundant (harmless), not required.

// See pushRow's docblock for why this one column gets special-cased.
const CASA_RATIO_COL = 'BFSI CASA Ratio';

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
//
// Like annual (see the comment above ANNUAL_STATEMENT_MAP), there used to be
// a hardcoded CSV-header -> abbr map here (QTR_COL_MAP) with a hard gate that
// threw if any of its ~30 entries were missing from the sheet. Dropped for
// the same reason: it's brittle against template changes (a new quarterly
// sheet with a different column vocabulary just throws) and every mapping
// change needed a code deploy. Every quarterly column now resolves purely
// dynamically against kpis.abbr/kpis.quarterly_prowess_name (see runQuarterly's
// resolveDynamicIndicators call, knownNames always empty for quarterly).
//
// The snapshot/flow start_date distinction (QTR_SNAPSHOT_ABBRS) is gone too,
// for the same reason it was dropped from annual: every quarterly row now
// gets a real start_date and period_type: 'quarterly', no more null-start_date
// "snapshot" rows.

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
  constructor({ table, csvPath, doInsert, doClear, constraintName, rowLimit, sourceType, companyFilter }) {
    this.table          = table;
    this.csvPath        = csvPath;
    this.doInsert       = doInsert;
    this.doClear        = doClear;
    this.rowLimit       = rowLimit ?? Infinity;
    this.sourceType     = sourceType ? sourceType.toUpperCase() : null;
    this.companyFilter  = companyFilter && companyFilter.length ? new Set(companyFilter.map(c => c.trim().toLowerCase())) : null;
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
   * the `kpis` table (exact match on `abbr` or the given name field), so new
   * quarterly/annual indicators can be onboarded via the admin flow (create a
   * Kpi row + prowess_name/quarterly_prowess_name) without a code deploy.
   * Returns the extra { headerName → kpi_abbr } entries to merge into the
   * normal column map, plus the headers that still have no home (candidates
   * for a new Kpi).
   *
   * @param {string} nameField - 'prowess_name' (annual) or
   *   'quarterly_prowess_name' (quarterly) — the two templates word the same
   *   concept differently often enough that one field can't hold both (see
   *   Kpi.quarterly_prowess_name's schema docblock).
   */
  async resolveDynamicIndicators(headers, knownNames, nameField = 'prowess_name') {
    const candidates = [...new Set(
      headers.map(h => (h || '').trim()).filter(h => h && !knownNames.has(h))
    )];
    if (!candidates.length) return { dynamicMap: {}, unmatched: [] };

    const matches = await this.prisma.kpi.findMany({
      where: { OR: [{ abbr: { in: candidates } }, { [nameField]: { in: candidates } }] },
      select: { abbr: true, [nameField]: true },
    });

    const dynamicMap = {};
    for (const kpi of matches) {
      if (candidates.includes(kpi.abbr))         dynamicMap[kpi.abbr] = kpi.abbr;
      const name = kpi[nameField];
      if (name && candidates.includes(name)) dynamicMap[name] = kpi.abbr;
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

  /** "Mar 2026" or "Mar-26" → { endDate: '2026-03-31', fiscalYear: 'FY2026' } */
  parseYearLabel(label) {
    const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
    const trimmed = (label || '').trim();
    const spaced = /^([A-Za-z]{3})\s+(\d{4})$/.exec(trimmed);   // e.g. "Mar 2026" (annual_2025.csv, osc_sheet_193.csv)
    const dashed = /^([A-Za-z]{3})-(\d{2})$/.exec(trimmed);     // e.g. "Mar-26"   (osc_sheet_192.csv)
    let mon, yr;
    if (spaced)      { [, mon, yr] = spaced; }
    else if (dashed) { const [, m, yy] = dashed; mon = m; yr = String(2000 + parseInt(yy, 10)); }
    else return null;
    const mm = MON[mon];
    if (!mm) return null;
    const lastDay = new Date(parseInt(yr), parseInt(mm), 0).getDate();
    return {
      endDate:    `${yr}-${mm}-${String(lastDay).padStart(2, '0')}`,
      fiscalYear: `FY${yr}`,
    };
  }

  /**
   * Which single section (Consolidated or Standalone) this file is. The
   * day-block bulk-historical template (osc_sheet_192/193.csv) ships one
   * section per file -- row 3 carries that one label in every populated
   * cell. The older single-year template instead put both sections
   * side-by-side in one file/row; if both labels turn up here, that's this
   * older shape, which the block-based parsing below can't handle -- fail
   * loudly rather than silently mislabeling one section's columns as the
   * other.
   */
  detectSectionType(sectionRow) {
    const labels = new Set();
    for (const cell of sectionRow) {
      const c = (cell || '').trim();
      if (!c) continue;
      if (/standalone/i.test(c))        labels.add('S');
      else if (/consolidated/i.test(c)) labels.add('C');
    }
    if (labels.size > 1) {
      throw new Error(
        'Row 3 contains both "Consolidated" and "Standalone" labels -- the annual ' +
        'importer expects one section per file. Split into two separate CSVs ' +
        '(one per section) and upload each separately.'
      );
    }
    return labels.size === 1 ? [...labels][0] : null;
  }

  /** Detect repeated label blocks (fiscal-year or quarter columns) from a header/label row by label-change boundaries. */
  detectLabelBlocks(labelRow) {
    const blocks = [];
    let cur = null;
    for (let i = 1; i < labelRow.length; i++) {
      const lbl = (labelRow[i] || '').trim();
      if (!lbl) continue;
      if (!cur || cur.label !== lbl) { cur = { label: lbl, start: i, end: i }; blocks.push(cur); }
      else cur.end = i;
    }
    return blocks;
  }

  /** Extract KPI rows from one section (C or S) and push into allRows. */
  processAnnualSection(dataRow, company, sectionColMap, yearInfo, sourceType, colUnitByIdx, allRows, columnMap = {}) {
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

      // "BFSI CASA Ratio" (osc_sheet_198.csv-style BFSI day-block template) is
      // mistagged "Rs. Crore" in row 4 -- verified against real bank data
      // (HDFC/Axis raw values 0.44/0.45 match their actual CASA ratios, not
      // crore-scale rupee amounts; Fino Payments Bank's steady 1.0 also lines
      // up, since payments banks can't hold term deposits). Always treat as a
      // percentage regardless of the CSV's own tag, and normalize a 0-1
      // fraction to percent-points to match how this same file's genuine
      // "(per cent)"-tagged NPA columns already store their values (e.g. 0.93
      // for 0.93%, not 93).
      let unit, effectiveNum;
      if (colName === CASA_RATIO_COL) {
        unit = '%';
        effectiveNum = Math.abs(num) <= 1 ? num * 100 : num;
      } else {
        unit = colUnitByIdx[idx] ?? 'Cr';
        effectiveNum = num;
      }
      const mult = UNIT_MULTIPLIER[unit] ?? 1;

      allRows.push({
        callId, company, source_type: sourceType,
        fiscal_year: fiscalYear, quarter: 'Q4', call_date: endDate,
        kpi_abbr:    abbr,
        value:       parseFloat((effectiveNum * mult).toFixed(4)),
        raw_value:   raw, unit, multiplier: mult,
        start_date:  startDate,
        end_date:    endDate,
        period_type: 'annual',
        source:      'QE',
        source_path: `prowess/${path.basename(this.csvPath)}`,
        statement:   ANNUAL_STATEMENT_MAP[abbr] ?? null,
      });
    };

    // Every column resolves dynamically against kpis.abbr/prowess_name --
    // there's no hardcoded map left to check first.
    for (const [colName, abbr] of Object.entries(columnMap)) {
      if (colName in sectionColMap) pushRow(colName, abbr);
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
    const dataRows   = records.slice(6).filter(r => {
      const name = (r[0] || '').trim();
      return name && (!this.companyFilter || this.companyFilter.has(name.toLowerCase()));
    }).slice(0, this.rowLimit);

    console.log(`  Companies : ${dataRows.length}${this.rowLimit < Infinity ? ` (limited to ${this.rowLimit})` : ''}`);
    console.log(`  Columns   : ${headers.length}`);

    // 2. One file = one section (Consolidated or Standalone) -- see
    // detectSectionType's docblock for why this fails loudly instead of
    // guessing when both labels are present.
    const sourceType = this.sourceType || this.detectSectionType(sectionRow);
    if (!sourceType) throw new Error('Could not determine section type ("Consolidated"/"Standalone") from row 3, and no --source-type was provided.');
    console.log(`  Section : ${sourceType === 'C' ? 'Consolidated' : 'Standalone'}`);

    // 3. Detect fiscal-year blocks (day-block convention -- the same ~20
    // metric columns repeat once per fiscal year) and parse each block's label.
    const blocks = this.detectLabelBlocks(yearRow);
    if (!blocks.length) throw new Error('No fiscal-year blocks found in row 5.');
    for (const b of blocks) {
      b.info = this.parseYearLabel(b.label);
      if (!b.info) throw new Error(`Cannot parse fiscal-year label: "${b.label}"`);
      b.colMap = this.buildColMap(headers, b.start, b.end);
    }
    console.log(`  Fiscal years : ${blocks.length} (${blocks.map(b => b.info.fiscalYear).join(', ')})`);

    // 4. Resolve every column against kpis.abbr/prowess_name -- there's no
    // hardcoded map to check first any more, so knownNames is always empty
    // and every CSV header goes through the admin-owned Kpi table. No hard
    // "required columns" gate either -- pushRow already no-ops per-entry when
    // a mapped column is absent, so a file simply carrying fewer columns than
    // another vintage just yields fewer KPI rows, not a thrown error; check
    // the "unmatched" list below and the per-KPI row counts in the report to
    // see what actually landed.
    const { dynamicMap, unmatched } = await this.resolveDynamicIndicators(Object.keys(blocks[0].colMap), new Set());
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

    // 6. Build all rows -- one company x one fiscal-year block per iteration
    console.log('Building rows…');
    const allRows = [];
    for (const dataRow of dataRows) {
      const company = (dataRow[0] || '').trim();
      if (!company) continue;
      for (const block of blocks) {
        this.processAnnualSection(dataRow, company, block.colMap, block.info, sourceType, colUnitByIdx, allRows, dynamicMap);
      }
    }
    const finalRows = this.deduplicateRows(allRows);

    // 7. Verification stats
    console.log(`\n${'─'.repeat(60)}`);
    console.log('VERIFICATION');
    console.log('─'.repeat(60));
    console.log(`Total rows : ${finalRows.length}  (source_type=${sourceType})`);

    const countByAbbr = {};
    for (const r of finalRows) countByAbbr[r.kpi_abbr] = (countByAbbr[r.kpi_abbr] || 0) + 1;
    console.log(`\nRows per KPI (${Object.keys(countByAbbr).length} distinct):`);
    for (const [abbr, cnt] of Object.entries(countByAbbr).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${abbr.padEnd(18)} : ${cnt}`);
    }

    // 8. Spot-check a known company
    const targets = ['A B B India Ltd.', 'Varun Beverages Ltd.', 'Schaeffler India Ltd.', 'Reliance Industries Ltd.', 'Infosys Ltd.', '20 Microns Ltd.'];
    for (const target of targets) {
      const rows = finalRows.filter(r => r.company === target);
      if (!rows.length) continue;
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Spot-check (${sourceType}): ${target}  (${rows.length} KPI rows across ${blocks.length} years)`);
      console.log('─'.repeat(60));
      const latestFy = blocks[blocks.length - 1].info.fiscalYear;
      for (const abbr of ['TOTAL_INCOME','REV_OP','TOTAL_COGS','TOTAL_OPEX','OTH_EXP','FIN_COST','DEP_AMORT','PBT','TAX_EXP','PAT','EPS_BASIC','ASSET_PPE','DEBT_LT','CURR_LIAB','NET_WORTH','RES_SURPLUS','CFO']) {
        const r = rows.find(x => x.kpi_abbr === abbr && x.fiscal_year === latestFy);
        if (r) {
          console.log(`  ${abbr.padEnd(14)} raw=${String(r.raw_value).padStart(14)} ${r.unit.padEnd(3)}  display=${(r.value / r.multiplier).toFixed(2)}`);
        } else {
          console.log(`  ${abbr.padEnd(14)} — not found (${latestFy})`);
        }
      }
      break;
    }

    // 9. EPS sanity check
    console.log('\n─── EPS sanity check (unit=Rs, mult=1 expected) ───');
    const epsSample = finalRows.filter(r => r.kpi_abbr === 'EPS_BASIC' && r.value > 0).slice(0, 5);
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
      sourceType, fiscalYears: blocks.map(b => b.info.fiscalYear),
      dynamicIndicatorsMatched: dynamicMap, unmatchedColumns: unmatched,
      totalRows: finalRows.length, rowsByKpi: countByAbbr,
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
      // Scoped to annual-ingested rows only (call_id prefix 'prowess_new_') --
      // an unscoped `DELETE FROM ${table}` here would also wipe the
      // separately-ingested quarterly rows, which this mode has no business
      // touching.
      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE call_id LIKE 'prowess_new_%'`
      );
      console.log(`✓ Cleared ${deleted} annual rows from ${table}.\n`);
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
    const dataRows = records.slice(6).filter(r => {
      const name = (r[0] || '').trim();
      return name && (!this.companyFilter || this.companyFilter.has(name.toLowerCase()));
    }).slice(0, this.rowLimit);

    console.log(`  Companies : ${dataRows.length}${this.rowLimit < Infinity ? ` (limited to ${this.rowLimit})` : ''}`);
    console.log(`  Columns   : ${headers.length}`);

    // 2. Section type detection ('Consolidated' -> 'C', 'Standalone' -> 'S')
    const sourceType = this.sourceType || this.detectSectionType(records[2]);
    if (!sourceType) {
      throw new Error('Could not determine section type ("Consolidated"/"Standalone") from row 3, and no --source-type was provided.');
    }
    console.log(`  Section   : ${sourceType === 'C' ? 'Consolidated (C)' : 'Standalone (S)'}`);

    // 3. Detect quarter blocks and parse their labels
    const blocks = this.detectLabelBlocks(yearRow);
    if (!blocks.length) throw new Error('No quarter blocks found in row 4.');
    for (const b of blocks) {
      b.info = this.parseQuarterLabel(b.label);
      if (!b.info) throw new Error(`Cannot parse quarter label: "${b.label}"`);
    }
    console.log(`  Quarters  : ${blocks.length} (${blocks.map(b => b.label).join(', ')})`);

    // 4. Unit lookup + per-block column maps
    const colUnitByIdx = {};
    for (let i = 0; i < unitRow.length; i++) {
      colUnitByIdx[i] = CSV_UNIT_MAP[(unitRow[i] || '').trim()] ?? null;
    }
    for (const b of blocks) b.colMap = this.buildColMap(headers, b.start, b.end);

    // 5. Resolve columns (first block) dynamically against
    // kpis.abbr/quarterly_prowess_name -- no hardcoded map or required-column
    // gate any more (see the comment above QTR_STATEMENT_MAP).
    const firstBlockHeaders = Object.keys(blocks[0].colMap);
    const { dynamicMap, unmatched } = await this.resolveDynamicIndicators(
      firstBlockHeaders, new Set(), 'quarterly_prowess_name'
    );
    if (Object.keys(dynamicMap).length) {
      console.log(`✓ Dynamically matched ${Object.keys(dynamicMap).length} column(s) via kpis table:`);
      for (const [colName, abbr] of Object.entries(dynamicMap)) console.log(`  "${colName}" → ${abbr}`);
    }
    if (unmatched.length) {
      console.log(`⚠ ${unmatched.length} column(s) have no KPI mapping (create a Kpi with matching quarterly_prowess_name to include them):`);
      for (const c of unmatched) console.log(`  ✗ "${c}"`);
    }
    const effectiveColMap = dynamicMap;

    // 6. Build all rows
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

        const callId = `prowess_qtr_${this.normalizeName(company)}_${fiscalYear}_${quarter}_${sourceType}`;

        for (const [colName, abbr] of Object.entries(effectiveColMap)) {
          const idx = block.colMap[colName];
          if (idx == null) continue;
          const raw = (dataRow[idx] || '').trim();
          if (!raw) continue;
          const num = parseFloat(raw);
          if (isNaN(num)) continue;

          let unit = colUnitByIdx[idx] ?? 'Cr';
          if (abbr === 'PRICE_BOOK_OVERVIEW' || abbr === 'PEG_OVERVIEW' || colName === 'PEG' || colName.includes('Price to Book')) {
            unit = 'x';
          } else if (abbr === 'CFO_PAT_OVERVIEW' || colName === 'CFO to Pat conversion') {
            unit = '%';
          } else if (abbr === 'EPS') {
            unit = 'Rs';
          }
          const mult = UNIT_MULTIPLIER[unit] ?? 1;

          const rowObj = {
            callId, company, source_type: sourceType,
            fiscal_year: fiscalYear, quarter, call_date: endDate,
            kpi_abbr:    abbr,
            value:       parseFloat((num * mult).toFixed(4)),
            raw_value:   raw, unit, multiplier: mult,
            start_date:  startDate,
            end_date:    endDate,
            period_type: 'quarterly',
            source:      'QE',
            source_path: `prowess/${path.basename(csvPath)}`,
            statement:   QTR_STATEMENT_MAP[abbr] ?? null,
          };
          allRows.push(rowObj);

          if (abbr === 'ROCE_OVERVIEW') {
            allRows.push({
              ...rowObj,
              kpi_abbr: 'ROCE',
            });
          }
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
      sourceType,
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
        `DELETE FROM ${table} WHERE call_id LIKE 'prowess_qtr_%'`
      );
      console.log(`✓ Cleared ${deleted} quarterly rows (including snapshot) from ${table}.\n`);
    }

    console.log(`Inserting ${finalRows.length} rows…`);
    const insertStats = await this.batchInsert(finalRows);

    // 10. Post-insert counts
    console.log('\nPost-insert quarterly row counts by quarter:');
    const dbCounts = await this.prisma.$queryRawUnsafe(
      `SELECT fiscal_year, quarter, COUNT(*)::int AS cnt
       FROM ${table} WHERE call_id LIKE 'prowess_qtr_%'
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
