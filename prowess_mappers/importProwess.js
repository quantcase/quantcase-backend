'use strict';

/**
 * prowess_mappers/importProwess.js
 *
 * Reads Prowess (CMIE) annual financial data from CSV and inserts it into
 * a new `prowess_kpi_values` table with the same schema as `kpi_values`.
 *
 * CSV structure:
 *   Row 0 : source tag (CMIE Expr)
 *   Row 1 : empty
 *   Row 2 : report type  (Consolidated / Standalone)
 *   Row 3 : unit row     (Rs. Crore / (%) / Times / Date / …)
 *   Row 4 : period tag   (L-1 = prior year, L = latest year)
 *   Row 5 : column names
 *   Row 6+: data (one row per company)
 *
 * Four sections per data row:
 *   Consolidated  L-1 : cols  1 –  74
 *   Consolidated  L   : cols 75 – 148
 *   Standalone    L-1 : cols 149 – 229  (extra BFSI cols 214-224)
 *   Standalone    L   : cols 230 – 310  (extra BFSI cols 295-305)
 *
 * Usage:
 *   node prowess_mappers/importProwess.js                         # interactive + insert
 *   node prowess_mappers/importProwess.js --dry-run               # show rows, no DB writes
 *   node prowess_mappers/importProwess.js --dry-run --no-prompt   # skip prompts (all skipped)
 *   node prowess_mappers/importProwess.js --no-prompt             # skip prompts, insert
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

const prisma  = new PrismaClient();
const DRY_RUN    = process.argv.includes('--dry-run');
const NO_PROMPT  = process.argv.includes('--no-prompt');  // skip all interactive prompts (use defaults)

const CSV_PATH = path.join(__dirname, '../tmp/osc_sheet_1 (1).csv');

// ─── Constants ────────────────────────────────────────────────────────────────

const DENOM_UNIT     = { rupee: 'Cr', percentage: '%', ratio: 'x', other: '' };
const CSV_UNIT_MAP   = { 'Rs. Crore': 'Cr', '(%)': '%', 'Times': 'x' };

/**
 * Multiplier by unit:
 *   Cr   → 10_000_000  (1 Crore = 10M rupees; value stored as absolute rupees)
 *   %    → 1           (no conversion)
 *   x    → 1           (no conversion)
 *   else → 1
 * getTimeSeries divides value / multiplier to recover the display (Crore) figure.
 */
const UNIT_MULTIPLIER = { Cr: 10_000_000, '%': 1, x: 1 };

/** KPI abbrs that are balance-sheet snapshots (no start_date / period_type = snapshot) */
const SNAPSHOT_ABBRS = new Set(['TOTAL_ASSETS', 'CASH_EQUIV']);

/** CSV sections (each represents one statement-type × year slice per company row) */
const SECTIONS = [
  { reportType: 'Consolidated', label: 'C', period: 'L_MINUS_1', startCol: 1,   endCol: 74  },
  { reportType: 'Consolidated', label: 'C', period: 'L',          startCol: 75,  endCol: 148 },
  { reportType: 'Standalone',   label: 'S', period: 'L_MINUS_1', startCol: 149, endCol: 229 },
  { reportType: 'Standalone',   label: 'S', period: 'L',          startCol: 230, endCol: 310 },
];

/**
 * Direct mapping: prowess column name → KPI abbr.
 * Derived from qe_kpi_config.json labels / aliases.
 */
const BASE_COL_MAP = {
  'Total income':
    'TOTAL_INCOME',
  'Total expenses':
    'TOTAL_OPEX',
  'Profit after tax (PAT)':
    'PAT',
  'Total assets':
    'TOTAL_ASSETS',
  'Net cash flow from operating activities':
    'CFO',
  'Net cash inflow or (outflow) from investing activities':
    'CFI',
  'Net cash inflow or (outflow) from financing activities':
    'CFF',
  'Net cash inflow or (outflow) due to net increase or (decrease) in cash and cash equivalents':
    'NET_CASH_CHANGE',
  'Cash and cash equivalents as at the end of the year':
    'CASH_EQUIV',
  'Cost of goods sold':
    'TOTAL_COGS',
  'Provision for direct tax':
    'TAX_EXP',
};

/**
 * REV_OP is sourced from two mutually-exclusive columns depending on company type.
 * Whichever is non-empty for a given row is used.
 */
const REV_OP_NON_FIN = 'Operating income for non-financial Cos.';
const REV_OP_FIN     = 'Operating income for financial Cos.';

/**
 * Financial columns with no current KPI config reference.
 * User is prompted for each: add as new KPI, use custom abbr, or skip.
 */
const CANDIDATE_COLS = [
  {
    col:        'Change in stock',
    csvUnit:    'Rs. Crore',
    suggestion: 'INV_CHG',
    kpiType:    'cogs',
    denom:      'rupee',
    note:       'P&L inventory change; equivalent to Changes in Inventories',
  },
  {
    col:        'Net Interest Margin (NIM) (%)',
    csvUnit:    '(%)',
    suggestion: 'NIM_PCT',
    kpiType:    'revenue',
    denom:      'percentage',
    note:       'BFSI-specific; only populated for banks/NBFCs',
  },
  {
    col:        'Working funds',
    csvUnit:    'Rs. Crore',
    suggestion: 'WORKING_FUNDS',
    kpiType:    'assets',
    denom:      'rupee',
    note:       'BFSI-specific working capital proxy',
  },
  {
    col:        'Deposits: Total',
    csvUnit:    'Rs. Crore',
    suggestion: 'DEP_TOTAL',
    kpiType:    'liabilities',
    denom:      'rupee',
    note:       'Standalone BFSI only',
  },
  {
    col:        'Borrowings: Total',
    csvUnit:    'Rs. Crore',
    suggestion: 'BORR_TOTAL',
    kpiType:    'liabilities',
    denom:      'rupee',
    note:       'Standalone BFSI only; first occurrence taken when col appears twice',
  },
  {
    col:        'Loan advances: Total',
    csvUnit:    'Rs. Crore',
    suggestion: 'LOAN_ADV_TOTAL',
    kpiType:    'assets',
    denom:      'rupee',
    note:       'Standalone BFSI only',
  },
  {
    col:        'Investment at BV: Total',
    csvUnit:    'Rs. Crore',
    suggestion: 'INV_BV_TOTAL',
    kpiType:    'assets',
    denom:      'rupee',
    note:       'Investments at book value; standalone BFSI only',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a company name to a safe callId fragment. */
function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

/** "31-03-2024" → "FY2024" */
function deriveFiscalYear(dateStr) {
  const [, , yyyy] = dateStr.split('-');
  return yyyy ? `FY${yyyy}` : null;
}

/** "31-03-2024" → "2024-03-31" */
function toIso(dateStr) {
  const [dd, mm, yyyy] = dateStr.split('-');
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** "2024-03-31" → "2023-04-01" (start of a 12-month period ending on that date) */
function startOfPeriod(endIso) {
  if (!endIso) return null;
  const d = new Date(endIso);
  d.setFullYear(d.getFullYear() - 1);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * When stdin is a TTY, ask interactively via readline.
 * When stdin is piped, drain all lines upfront and return them in order.
 * Returns an `ask(question)` function that works in both modes.
 */
async function buildAsker() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (q) => new Promise(resolve => rl.question(q, resolve)),
      close: () => rl.close(),
    };
  }
  // Piped: read all lines upfront before any prompts
  const lines = await new Promise(resolve => {
    const buf = [];
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', l => buf.push(l.trim()));
    rl.on('close', () => resolve(buf));
  });
  let idx = 0;
  return {
    ask: (q) => {
      const answer = lines[idx++] ?? '';
      process.stdout.write(q + answer + '\n');  // echo so output is readable
      return Promise.resolve(answer);
    },
    close: () => {},
  };
}

/**
 * Build a map of column-name → absolute CSV index for one section.
 * When the same column name appears multiple times (e.g. "Borrowings: Total"),
 * the first occurrence is kept (per CMIE data structure conventions).
 */
function buildColMap(headers, startCol, endCol) {
  const map = {};
  for (let i = startCol; i <= endCol; i++) {
    const h = headers[i];
    if (h && !(h in map)) map[h] = i;
  }
  return map;
}

// ─── Table creation ────────────────────────────────────────────────────────────

async function ensureTable() {
  // Each $executeRawUnsafe call must contain exactly one SQL statement.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS prowess_kpi_values (LIKE kpi_values INCLUDING DEFAULTS)`
  );
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'prowess_kv_call_kpi_unique'
      ) THEN
        ALTER TABLE prowess_kpi_values
          ADD CONSTRAINT prowess_kv_call_kpi_unique UNIQUE (call_id, kpi_abbr);
      END IF;
    END $$
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pkv_call_id      ON prowess_kpi_values (call_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pkv_company_fy_q ON prowess_kpi_values (company, fiscal_year, quarter)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pkv_company_kpi  ON prowess_kpi_values (company, kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pkv_kpi          ON prowess_kpi_values (kpi_abbr)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pkv_kpi_period   ON prowess_kpi_values (kpi_abbr, period_type)`);
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

    const sql = `
      INSERT INTO prowess_kpi_values (
        id, call_id, company, fiscal_year, quarter, call_date,
        kpi_abbr, value, raw_value, unit, multiplier,
        start_date, end_date, period_type, source, source_path,
        statement, created_at, updated_at
      ) VALUES ${placeholders.join(',\n')}
      ON CONFLICT ON CONSTRAINT prowess_kv_call_kpi_unique DO NOTHING;
    `;

    await prisma.$executeRawUnsafe(sql, ...params);
    inserted += batch.length;
    process.stdout.write(`  Progress: ${inserted}/${rows.length}\r`);
  }
  console.log(`\n✓ Inserted ${inserted} rows`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Prowess CSV → prowess_kpi_values importer ===');
  if (DRY_RUN) console.log('[DRY RUN — no DB writes]\n');
  else         console.log();

  // ── 1. Parse CSV ────────────────────────────────────────────────────────────
  console.log('Parsing CSV…');
  const raw     = fs.readFileSync(CSV_PATH);
  const records = parse(raw, { bom: true, relax_column_count: true });

  const COL_HEADERS = records[5];   // row 5 = column names
  const COL_UNITS   = records[3];   // row 3 = units
  const dataRows    = records.slice(6).filter(r => r[0]?.trim());

  console.log(`  Companies: ${dataRows.length}`);
  console.log(`  Columns:   ${COL_HEADERS.length}\n`);

  // Build section maps once
  const sectionMaps = SECTIONS.map(s => ({
    ...s,
    colMap: buildColMap(COL_HEADERS, s.startCol, s.endCol),
  }));

  // ── 2. Load QE KPIs from DB ─────────────────────────────────────────────────
  const dbKpis     = await prisma.kpi.findMany({ where: { source: 'QE' } });
  const denomMap   = new Map(dbKpis.map(k => [k.abbr, k.denomination]));
  const abbrSet    = new Set(dbKpis.map(k => k.abbr));
  console.log(`Loaded ${dbKpis.length} QE KPIs from DB.\n`);

  // ── 3. Interactive: resolve unmapped candidate columns ───────────────────────
  const asker = NO_PROMPT ? null : await buildAsker();

  const finalColMap = { ...BASE_COL_MAP };

  console.log('─── Unmapped financial columns ───────────────────────────────');
  console.log('These columns have no direct reference in qe_kpi_config.json.\n');

  for (const c of CANDIDATE_COLS) {
    const inDb = abbrSet.has(c.suggestion);

    if (inDb) {
      // Already seeded in the kpis table — auto-map
      console.log(`  [AUTO] "${c.col}"\n         → ${c.suggestion} already in kpis table.\n`);
      finalColMap[c.col] = c.suggestion;
      continue;
    }

    if (NO_PROMPT) {
      console.log(`  [SKIP] "${c.col}" — not in DB, skipped (--no-prompt)\n`);
      continue;
    }

    console.log(`  Column : "${c.col}" (${c.csvUnit})`);
    console.log(`  Note   : ${c.note}`);
    console.log(`  Suggest: ${c.suggestion}`);
    const ans = (await asker.ask('  Add as new KPI? [y / n / custom-abbr, default n]: ')).trim();

    if (!ans || ans.toLowerCase() === 'n') {
      console.log(`  → Skipped.\n`);
      continue;
    }

    const abbr = ans.toLowerCase() === 'y' ? c.suggestion : ans.toUpperCase();

    if (abbrSet.has(abbr)) {
      console.log(`  → ${abbr} already in DB. Mapping "${c.col}" to it.\n`);
      finalColMap[c.col] = abbr;
      denomMap.set(abbr, denomMap.get(abbr) ?? c.denom);
      continue;
    }

    if (!DRY_RUN) {
      await prisma.kpi.create({
        data: {
          abbr,
          full_form:    c.col,
          kpi_type:     c.kpiType,
          denomination: c.denom,
          industry:     [],
          source:       'QE',
        },
      });
    }
    abbrSet.add(abbr);
    denomMap.set(abbr, c.denom);
    finalColMap[c.col] = abbr;
    console.log(`  → Created KPI "${abbr}" (${c.col}) in kpis table.\n`);
  }

  if (asker) asker.close();

  // ── 4. Print final mapping ───────────────────────────────────────────────────
  console.log('\n─── Final column → KPI mapping ───────────────────────────────');
  for (const [col, abbr] of Object.entries(finalColMap)) {
    console.log(`  ${abbr.padEnd(20)} ← "${col.slice(0, 75)}"`);
  }
  console.log(`  ${'REV_OP'.padEnd(20)} ← "${REV_OP_NON_FIN}" OR "${REV_OP_FIN}" (non-null wins)`);
  console.log();

  // ── 5. Create table ──────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    process.stdout.write('Creating prowess_kpi_values table…');
    await ensureTable();
    console.log(' done.\n');
  }

  // ── 6. Build rows ────────────────────────────────────────────────────────────
  console.log('Building rows…');

  function getUnit(abbr, colIdx) {
    const denom = denomMap.get(abbr);
    if (denom) return DENOM_UNIT[denom] ?? null;
    const csvUnit = COL_UNITS[colIdx] ?? '';
    return CSV_UNIT_MAP[csvUnit] ?? null;
  }

  function getMultiplier(unit) {
    return UNIT_MULTIPLIER[unit] ?? 1;
  }

  const allRows = [];

  for (const dataRow of dataRows) {
    const company = dataRow[0].trim();
    if (!company) continue;
    const companySafe = normalizeName(company);

    for (const section of sectionMaps) {
      const cm = section.colMap;

      const yearRaw = dataRow[cm['Year']]?.trim() ?? '';
      const months  = dataRow[cm['Months']]?.trim() ?? '';

      if (!yearRaw) continue;             // section has no data for this company
      if (months && months !== '12') continue;  // skip partial-year entries

      const endDate   = toIso(yearRaw);
      const fiscalYear = deriveFiscalYear(yearRaw);
      if (!endDate || !fiscalYear) continue;

      const startDate = startOfPeriod(endDate);

      // Synthetic callId: prowess_{COMPANY_SAFE}_{FY2024}_{C|S}
      const callId = `prowess_${companySafe}_${fiscalYear}_${section.label}`;

      // ── mapped columns
      for (const [colName, abbr] of Object.entries(finalColMap)) {
        const colIdx = cm[colName];
        if (colIdx === undefined) continue;

        const raw = dataRow[colIdx]?.trim() ?? '';
        if (!raw) continue;
        const num = parseFloat(raw);
        if (isNaN(num)) continue;

        const isSnap = SNAPSHOT_ABBRS.has(abbr);
        const unit   = getUnit(abbr, colIdx);
        const mult   = getMultiplier(unit);

        allRows.push({
          callId,
          company,
          fiscal_year: fiscalYear,
          quarter:     null,
          call_date:   endDate,
          kpi_abbr:    abbr,
          value:       parseFloat((num * mult).toFixed(4)),
          raw_value:   raw,
          unit,
          multiplier:  mult,
          start_date:  isSnap ? null : startDate,
          end_date:    endDate,
          period_type: isSnap ? 'snapshot' : 'annual',
          source:      'QE',
          source_path: '',
          statement:   null,
        });
      }

      // ── REV_OP (take first non-empty of the two source columns)
      const nfIdx = cm[REV_OP_NON_FIN];
      const fIdx  = cm[REV_OP_FIN];
      const revRaw =
        (nfIdx !== undefined && dataRow[nfIdx]?.trim()) ? dataRow[nfIdx].trim()
        : (fIdx  !== undefined && dataRow[fIdx]?.trim())  ? dataRow[fIdx].trim()
        : null;

      if (revRaw) {
        const num  = parseFloat(revRaw);
        const unit = getUnit('REV_OP', nfIdx ?? fIdx);
        const mult = getMultiplier(unit);
        if (!isNaN(num)) {
          allRows.push({
            callId,
            company,
            fiscal_year: fiscalYear,
            quarter:     null,
            call_date:   endDate,
            kpi_abbr:    'REV_OP',
            value:       parseFloat((num * mult).toFixed(4)),
            raw_value:   revRaw,
            unit,
            multiplier:  mult,
            start_date:  startDate,
            end_date:    endDate,
            period_type: 'annual',
            source:      'QE',
            source_path: '',
            statement:   null,
          });
        }
      }
    }
  }

  // ── Deduplicate by (callId, kpi_abbr) — keep first occurrence
  const seen      = new Set();
  const finalRows = [];
  for (const row of allRows) {
    const key = `${row.callId}|${row.kpi_abbr}`;
    if (!seen.has(key)) {
      seen.add(key);
      finalRows.push(row);
    }
  }

  console.log(`  Raw rows:   ${allRows.length}`);
  console.log(`  After dedup: ${finalRows.length}`);
  console.log();

  // ── 7. Insert ────────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('[DRY RUN] Sample rows (first 5):');
    finalRows.slice(0, 5).forEach(r => {
      console.log(`  ${r.callId.padEnd(45)} ${r.kpi_abbr.padEnd(16)} value=${r.value}`);
    });
    console.log(`  … and ${finalRows.length - 5} more rows.\n`);
    console.log(`[DRY RUN] No data written. Re-run without --dry-run to insert.`);
  } else {
    console.log('Inserting rows…');
    await batchInsert(finalRows);

    // Quick summary
    const count = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM prowess_kpi_values`;
    console.log(`\nTotal rows in prowess_kpi_values: ${count[0].n}`);

    const kpiBreakdown = await prisma.$queryRaw`
      SELECT kpi_abbr, COUNT(*)::int AS n
      FROM prowess_kpi_values
      GROUP BY kpi_abbr
      ORDER BY n DESC
    `;
    console.log('\nRows per KPI:');
    kpiBreakdown.forEach(r => console.log(`  ${r.kpi_abbr.padEnd(20)} ${r.n}`));
  }
}

main()
  .catch(err => { console.error('\nError:', err.message ?? err); process.exit(1); })
  .finally(() => prisma.$disconnect());
