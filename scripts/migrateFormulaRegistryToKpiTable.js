'use strict';

/**
 * One-off migration: moves the old hardcoded formulaRegistry entries
 * (utils/formulaRegistry/financialEntries.a.js, financialEntries.b.js, and
 * the handful of REGISTRY-cross-referencing entries that used to live inline
 * in financial.js before this migration) into Kpi rows + KpiRelationship
 * rows, per .claude/plans/shimmying-skipping-lighthouse.md §4.
 *
 * Usage:
 *   node scripts/migrateFormulaRegistryToKpiTable.js            # dry run, prints a report
 *   node scripts/migrateFormulaRegistryToKpiTable.js --insert   # writes to DB
 *
 * The `kpis` table is shared with an unrelated transcript-metric dedup
 * pipeline (~23.4k rows, source:'transcript'). Existing rows (raw Prowess
 * columns with source:'QE', and the handful of abbrs — EBITDA, ROE, etc. —
 * that collide with transcript-dedup canonical names) are upserted: only the
 * new formulaRegistry columns (formula_expression, frequency, fallback_abbrs,
 * unit_label, description, display_order) are ever written to an existing
 * row; source/full_form/kpi_type/denomination/industry/prowess_name are left
 * untouched.
 *
 * Known gap (documented, not silently wrong): HISTORICAL_PE_3Y/5Y are not
 * migrated — they average PE over one point per *calendar year* built from a
 * blended daily/weekly nse_equity_new cadence (see
 * project_nse_equity_new_cadence memory), which doesn't fit the resolver's
 * current 'daily' frequency model (latest-snapshot only, no historical
 * series). Not referenced by any in-scope consumer (screener.controller.js /
 * lib/financials.js) today.
 */

const prisma = require('../config/prisma');
const { parse, collectReferences, ExpressionError } = require('../utils/formulaRegistry/expressionEvaluator');
const { BFSI_INDUSTRIES } = require('../utils/industryClassifier');

const DO_INSERT = process.argv.includes('--insert');

// ── Raw leaves ──────────────────────────────────────────────────────────────
// [abbr, full_form, unit_label, statement|null, fallback_abbrs?, frequency?]
const RAW_ENTRIES = [
  ['EQ_SHARE_CAP',  'Equity Share Capital',    'Cr', 'balance_sheet'],
  ['RES_SURPLUS',   'Reserves & Surplus',      'Cr', 'balance_sheet'],
  ['TOTAL_LIAB',    'Total Liabilities',       'Cr', 'balance_sheet'],
  ['CURR_LIAB',     'Current Liabilities',     'Cr', 'balance_sheet'],
  ['CURR_ASSETS',   'Current Assets',          'Cr', 'balance_sheet'],
  ['INVENTORY',     'Inventory',               'Cr', 'balance_sheet'],
  ['CASH_EQUIV',    'Cash & Cash Equivalents', 'Cr', 'balance_sheet'],
  ['ASSET_PPE',     'Fixed Assets (PPE)',      'Cr', 'balance_sheet'],
  ['ASSET_CWIP',    'Capital Work-in-Progress','Cr', 'balance_sheet'],
  ['INV_NONCURR',   'Non-current Investments', 'Cr', 'balance_sheet'],
  ['TOTAL_ASSETS',  'Total Assets',            'Cr', 'balance_sheet'],
  ['DEBT_LT',       'Long-term Debt',          'Cr', 'balance_sheet'],
  ['DEBT_ST',       'Short-term Debt',         'Cr', 'balance_sheet'],

  ['REV_OP',        'Revenue from Operations',      'Cr', 'pnl'],
  ['TOTAL_INCOME',  'Total Income',                 'Cr', 'pnl'],
  ['TOTAL_OPEX',    'Total Operating Expenses',     'Cr', 'pnl'],
  ['TOTAL_COGS',    'Cost of Goods Sold',           'Cr', 'pnl'],
  ['OTH_INC',       'Other Income',                 'Cr', 'pnl'],
  ['FIN_COST',      'Finance Costs (Interest)',     'Cr', 'pnl'],
  ['DEP_AMORT',     'Depreciation & Amortisation',  'Cr', 'pnl'],
  ['TAX_EXP',       'Tax Expense',                  'Cr', 'pnl'],
  ['PBT',           'Profit Before Tax',            'Cr', 'pnl'],
  ['PAT',           'Profit After Tax',             'Cr', 'pnl'],
  ['EPS_BASIC',     'Basic EPS',                    '₹',  'pnl'],
  ['EPS_DILUTED',   'Diluted EPS',                  '₹',  'pnl'],

  ['CFO', 'Cash from Operations', 'Cr', 'cashflow'],
  ['CFI', 'Cash from Investing',  'Cr', 'cashflow'],
  ['CFF', 'Cash from Financing',  'Cr', 'cashflow'],

  // Stored directly when present; falls back to a formula when not (see
  // FORMULA_ENTRIES' *_CALC companions below).
  ['NET_WORTH',  'Net Worth / Shareholders Equity', 'Cr', 'balance_sheet', ['NET_WORTH_CALC']],
  ['BORR_TOTAL', 'Total Borrowings',                'Cr', 'balance_sheet', ['BORR_TOTAL_CALC']],

  // Daily, from nse_equity_new (not prowess_values_new) — injected by the
  // resolver via resolutionContext's market-snapshot adapter.
  ['PRICE', 'Share Price (NSE)', '₹', null, [], 'daily'],
];

// ── Plain-arithmetic formula entries ────────────────────────────────────────
// [abbr, full_form, unit_label, expression, statement|null, frequency?]
const FORMULA_ENTRIES = [
  ['EBITDA',           'EBITDA',                       'Cr', 'PBT + FIN_COST + DEP_AMORT'],
  ['PROFIT_MARGIN',    'Net Profit Margin',             '%', 'PAT / REV_OP * 100'],
  ['GROSS_MARGIN',     'Gross Profit Margin',           '%', '(TOTAL_INCOME - TOTAL_COGS) / REV_OP * 100'],
  ['OP_MARGIN',        'Operating Margin',              '%', '(REV_OP - TOTAL_OPEX) / REV_OP * 100'],
  ['ROCE',             'Return on Capital Employed',    '%', '(PBT + FIN_COST) / (TOTAL_ASSETS - CURR_LIAB) * 100'],
  ['ROA',              'Return on Assets',               '%', 'PAT / TOTAL_ASSETS * 100'],
  ['ROE',              'Return on Equity',               '%', 'PAT / NET_WORTH * 100'],
  ['DE',               'Debt-to-Equity',                 'x', 'BORR_TOTAL / NET_WORTH'],
  ['NET_DEBT',         'Net Debt',                      'Cr', 'BORR_TOTAL - CASH_EQUIV'],
  ['CURRENT_RATIO',    'Current Ratio',                  'x', 'CURR_ASSETS / CURR_LIAB'],
  ['QUICK_RATIO',      'Quick Ratio',                    'x', '(CURR_ASSETS - INVENTORY) / CURR_LIAB'],
  ['GROSS_PROFIT',     'Gross Profit',                  'Cr', 'TOTAL_INCOME - TOTAL_COGS'],
  ['OCF_PAT',          'OCF / PAT',                      'x', 'CFO / PAT'],
  ['EBITDA_MARGIN',    'EBITDA Margin',                  '%', 'EBITDA / REV_OP * 100'],
  ['NET_DEBT_EBITDA',  'Net Debt / EBITDA',               'x', 'NET_DEBT / EBITDA'],
  ['CFO_EBITDA_PCT',   'CFO / EBITDA %',                  '%', 'CFO / EBITDA * 100'],
  ['CASH_CONVERSION',  'Cash Conversion',                 '%', 'FCF / PAT * 100'],
  ['MARKET_CAP_CR',    'Market Capitalisation',          'Cr', 'PRICE * EQ_SHARE_CAP / 10'],
  ['PB_TTM',           'Price to Book Value',             'x', 'MARKET_CAP_CR / (NET_WORTH / 10000000)'],
  ['PE_TTM',           'PE Ratio (TTM)',                  'x', 'PRICE / TTM_EPS'],
  ['EV_EBITDA_TTM',    'EV / EBITDA (TTM)',               'x', '(PRICE * EQ_SHARE_CAP / 10 + BORR_TOTAL - CASH_EQUIV) / TTM_EBITDA'],
  ['MC_SALES_TTM',     'Market Cap / Sales (TTM)',        'x', '(PRICE * EQ_SHARE_CAP / 10) / TTM_REV'],
  ['PEG_RATIO',        'PEG Ratio',                       'x', 'PE_TTM / CAGR(EPS_BASIC, 3)'],

  // Fallback targets — internal, not meant to be resolved directly by callers.
  ['NET_WORTH_CALC',   'Net Worth (Calculated)',         'Cr', 'EQ_SHARE_CAP + RES_SURPLUS'],
  ['BORR_TOTAL_CALC',  'Total Borrowings (Calculated)',  'Cr', 'DEBT_LT + DEBT_ST'],

  // TTM helpers — pinned to quarterly frequency regardless of caller context,
  // since a trailing-twelve-months figure is always a sum of 4 quarters.
  ['TTM_EPS',    'TTM EPS',    '₹', 'SUM(EPS_BASIC, 4)', null, 'quarterly'],
  // SUM distributes over addition, so this is exactly SUM(EBITDA,4) without
  // needing per-period formula evaluation for a linear formula. PBT isn't a
  // distinct column in the quarterly Prowess CSV (QTR_COL_MAP has no 'PBT'
  // mapping) — COALESCE falls back to PAT+TAX_EXP (PBT = PAT + TAX_EXP
  // always holds), mirroring the old lib/financials.js pbtTtm fallback.
  ['TTM_EBITDA', 'TTM EBITDA', 'Cr',
    'COALESCE(SUM(PBT, 4), SUM(PAT, 4) + SUM(TAX_EXP, 4)) + SUM(FIN_COST, 4) + SUM(DEP_AMORT, 4)',
    null, 'quarterly'],
  ['TTM_REV',    'TTM Revenue','Cr', 'SUM(REV_OP, 4)', null, 'quarterly'],

  // CAPEX — the one former 'delta' type. MAX(0, ...) replaces the old
  // Math.max(0, ...) floor; DELTA(x) replaces the old curr/prev diffing.
  // COALESCE(DELTA(x), 0) replaces the old `(dLand ?? 0) + ...` — a missing
  // PPE-breakdown component contributes 0 rather than nulling the whole sum
  // (minor documented simplification: unlike the old code, this no longer
  // requires ASSET_LAND_GRS or ASSET_PM_GRS specifically to be present —
  // if every component is missing the result is 0, not "no data").
  ['CAPEX', 'Capital Expenditure', 'Cr',
    'MAX(0, COALESCE(DELTA(ASSET_LAND_GRS),0) + COALESCE(DELTA(ASSET_PM_GRS),0) + ' +
    'COALESCE(DELTA(ASSET_MINING_NET),0) + COALESCE(DELTA(ASSET_BIO_NET),0) + ' +
    'COALESCE(DELTA(ASSET_LEASE_IMP_NET),0) + COALESCE(DELTA(ASSET_TRANS_NET),0) + ' +
    'COALESCE(DELTA(ASSET_FURN_NET),0) + COALESCE(DELTA(ASSET_CWIP),0))'],
];

// ── BFSI variant pairs (formerly `formula: {standard, bfsi}`) ──────────────
// [standardAbbr, bfsiAbbr, fullForm, unitLabel, standardExpr, bfsiExpr]
const BFSI_PAIRS = [
  ['EBIT', 'EBIT_BFSI', 'EBIT / PPOP', 'Cr',
    'PBT + FIN_COST', 'REV_OP - EMP_EXP - OTH_EXP - DEP_AMORT'],
  ['EBIT_MARGIN', 'EBIT_MARGIN_BFSI', 'EBIT Margin / PPOP Margin', '%',
    'EBIT / REV_OP * 100', 'EBIT_BFSI / REV_OP * 100'],
  ['FCF', 'FCF_BFSI', 'Free Cash Flow', 'Cr',
    'CFO - CAPEX', 'CFO - CAPEX - PROV_CONT'],
];

// ── CAGR / AVG entries ───────────────────────────────────────────────────────
// [abbr, fullForm, baseAbbr, window|null]
const CAGR_ENTRIES = [
  ['EPS_CAGR',     'EPS CAGR',              'EPS_BASIC', null],
  ['EPS_CAGR_3Y',  'EPS 3-year CAGR',       'EPS_BASIC', 3],
  ['EPS_CAGR_5Y',  'EPS 5-year CAGR',       'EPS_BASIC', 5],
  ['REV_CAGR',     'Revenue CAGR',          'REV_OP',    null],
  ['REV_CAGR_3Y',  'Revenue 3-year CAGR',   'REV_OP',    3],
  ['REV_CAGR_5Y',  'Revenue 5-year CAGR',   'REV_OP',    5],
  ['REV_CAGR_10Y', 'Revenue 10-year CAGR',  'REV_OP',    10],
  ['PAT_CAGR',     'PAT CAGR',              'PAT',       null],
  ['PAT_CAGR_3Y',  'PAT 3-year CAGR',       'PAT',       3],
  ['PAT_CAGR_5Y',  'PAT 5-year CAGR',       'PAT',       5],
  ['PAT_CAGR_10Y', 'PAT 10-year CAGR',      'PAT',       10],
];

const AVERAGE_ENTRIES = [
  ['ROCE_3Y_AVG', 'ROCE 3-year Average', 'ROCE', 3],
  ['ROE_3Y_AVG',  'ROE 3-year Average',  'ROE',  3],
  ['ROE_5Y_AVG',  'ROE 5-year Average',  'ROE',  5],
  ['ROE_10Y_AVG', 'ROE 10-year Average', 'ROE',  10],
];

// ── Statement header rows (organizational, no formula/data of their own) ───
const STATEMENT_HEADERS = [
  ['PNL_STATEMENT',           'Profit & Loss Statement'],
  ['BALANCE_SHEET_STATEMENT', 'Balance Sheet'],
  ['CASHFLOW_STATEMENT',      'Cash Flow Statement'],
];
const STATEMENT_ABBR = {
  pnl: 'PNL_STATEMENT',
  balance_sheet: 'BALANCE_SHEET_STATEMENT',
  cashflow: 'CASHFLOW_STATEMENT',
};

// ── Report accumulator ──────────────────────────────────────────────────────
const report = { created: [], updated: [], skipped: [], parseErrors: [], relationships: 0, companyGroup: null };

function normalizeUnicode(expr) {
  return expr.replace(/×/g, '*').replace(/−/g, '-').replace(/÷/g, '/');
}

async function upsertKpi(abbr, patch) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  const data = {
    registry_enabled:    true,
    formula_expression: patch.formula_expression ?? null,
    frequency:           patch.frequency ?? null,
    fallback_abbrs:       patch.fallback_abbrs ?? [],
    unit_label:           patch.unit_label ?? null,
    description:          patch.description ?? null,
    display_order:        patch.display_order ?? 0,
  };

  if (existing) {
    if (DO_INSERT) await prisma.kpi.update({ where: { abbr }, data });
    report.updated.push(abbr);
  } else {
    if (DO_INSERT) {
      await prisma.kpi.create({
        data: {
          abbr,
          full_form: patch.full_form,
          source: 'QE',
          denomination: null,
          industry: [],
          ...data,
        },
      });
    }
    report.created.push(abbr);
  }
}

async function upsertRelationship(kpi_abbr, relationship_type, { related_kpi_abbr = null, company_group_slug = null, display_order = 0 } = {}) {
  const existing = await prisma.kpiRelationship.findFirst({
    where: { kpi_abbr, relationship_type, related_kpi_abbr, company_group_slug },
  });
  if (existing) return;
  if (DO_INSERT) {
    await prisma.kpiRelationship.create({
      data: { kpi_abbr, relationship_type, related_kpi_abbr, company_group_slug, display_order },
    });
  }
  report.relationships++;
}

async function seedBfsiCompanyGroup() {
  const existing = await prisma.companyGroup.findUnique({ where: { slug: 'bfsi' } });
  if (existing) { report.companyGroup = 'exists'; return; }
  report.companyGroup = DO_INSERT ? 'created' : 'would-create';
  if (!DO_INSERT) return;
  await prisma.companyGroup.create({
    data: {
      slug: 'bfsi',
      name: 'BFSI',
      description: 'Banks, NBFCs, insurers, AMCs, fintech, etc. — used by formulaRegistry for BFSI-variant metric formulas (EBIT, EBIT_MARGIN, FCF).',
      filter_type: 'dynamic',
      filter_config: { industries: [...BFSI_INDUSTRIES] },
    },
  });
}

function validateExpression(abbr, expr, knownAbbrs) {
  let ast;
  try {
    ast = parse(normalizeUnicode(expr));
  } catch (err) {
    if (err instanceof ExpressionError) {
      report.parseErrors.push(`${abbr}: ${err.message} — "${expr}"`);
      return null;
    }
    throw err;
  }
  const refs = collectReferences(ast);
  const unknown = refs.filter(r => !knownAbbrs.has(r));
  if (unknown.length) {
    report.parseErrors.push(`${abbr}: references unknown abbr(s) [${unknown.join(', ')}] — "${expr}"`);
  }
  return ast;
}

async function main() {
  console.log(`=== migrateFormulaRegistryToKpiTable ${DO_INSERT ? '[INSERT MODE]' : '[DRY RUN]'} ===\n`);

  // Build the full set of abbrs this migration will define, for reference validation.
  const knownAbbrs = new Set([
    ...RAW_ENTRIES.map(e => e[0]),
    ...FORMULA_ENTRIES.map(e => e[0]),
    ...BFSI_PAIRS.flatMap(e => [e[0], e[1]]),
    ...CAGR_ENTRIES.map(e => e[0]),
    ...AVERAGE_ENTRIES.map(e => e[0]),
    ...STATEMENT_HEADERS.map(e => e[0]),
  ]);
  // Also allow references to abbrs that already exist in the DB today
  // (EMP_EXP, OTH_EXP, PROV_CONT, the 12 PPE-breakdown abbrs — all seeded
  // independently by ProwessUploader) — fetch the current QE abbr set.
  const existingQe = await prisma.kpi.findMany({ where: { source: 'QE' }, select: { abbr: true } });
  for (const { abbr } of existingQe) knownAbbrs.add(abbr);

  // 1. Validate every expression parses and every reference resolves.
  for (const [abbr, , , expr] of FORMULA_ENTRIES) validateExpression(abbr, expr, knownAbbrs);
  for (const [stdAbbr, bfsiAbbr, , , stdExpr, bfsiExpr] of BFSI_PAIRS) {
    validateExpression(stdAbbr, stdExpr, knownAbbrs);
    validateExpression(bfsiAbbr, bfsiExpr, knownAbbrs);
  }

  if (report.parseErrors.length) {
    console.log('✗ Validation errors — fix before inserting:\n');
    for (const e of report.parseErrors) console.log(`  ${e}`);
    if (DO_INSERT) { console.log('\nAborting — re-run in dry-run mode to see the full report.'); process.exit(1); }
  }

  // 2. Raw entries
  for (const [abbr, full_form, unit_label, statement, fallback_abbrs = [], frequency = null] of RAW_ENTRIES) {
    await upsertKpi(abbr, { full_form, unit_label, fallback_abbrs, frequency });
    if (statement) await upsertRelationship(abbr, 'statement_of', { related_kpi_abbr: STATEMENT_ABBR[statement] });
  }

  // 3. Statement headers (organizational, no formula)
  for (const [abbr, full_form] of STATEMENT_HEADERS) {
    await upsertKpi(abbr, { full_form });
  }

  // 4. Plain formula entries
  for (const [abbr, full_form, unit_label, expr, statement = null, frequency = null] of FORMULA_ENTRIES) {
    await upsertKpi(abbr, { full_form, unit_label, formula_expression: normalizeUnicode(expr), frequency });
    if (statement) await upsertRelationship(abbr, 'statement_of', { related_kpi_abbr: STATEMENT_ABBR[statement] });
  }

  // 5. BFSI variant pairs
  for (const [stdAbbr, bfsiAbbr, full_form, unit_label, stdExpr, bfsiExpr] of BFSI_PAIRS) {
    await upsertKpi(stdAbbr, { full_form, unit_label, formula_expression: normalizeUnicode(stdExpr) });
    await upsertKpi(bfsiAbbr, { full_form: `${full_form} (BFSI)`, unit_label, formula_expression: normalizeUnicode(bfsiExpr) });
    await upsertRelationship(stdAbbr, 'variant_for_group', { company_group_slug: 'bfsi', related_kpi_abbr: bfsiAbbr });
  }

  // 6. CAGR / AVG entries
  for (const [abbr, full_form, baseAbbr, window] of CAGR_ENTRIES) {
    const expr = window != null ? `CAGR(${baseAbbr}, ${window})` : `CAGR(${baseAbbr})`;
    validateExpression(abbr, expr, knownAbbrs);
    await upsertKpi(abbr, { full_form, unit_label: '%', formula_expression: expr });
  }
  for (const [abbr, full_form, baseAbbr, window] of AVERAGE_ENTRIES) {
    const expr = `AVG(${baseAbbr}, ${window})`;
    validateExpression(abbr, expr, knownAbbrs);
    await upsertKpi(abbr, { full_form, unit_label: '%', formula_expression: expr });
  }

  // 7. BFSI CompanyGroup (dynamic, industries filter — reproduces isBFSI() exactly)
  await seedBfsiCompanyGroup();

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`Raw + formula + cagr/avg entries processed : ${report.created.length + report.updated.length}`);
  console.log(`  created : ${report.created.length}${report.created.length ? ` (${report.created.join(', ')})` : ''}`);
  console.log(`  updated : ${report.updated.length}`);
  console.log(`Relationships ${DO_INSERT ? 'created' : 'to create'}: ${report.relationships}`);
  console.log(`BFSI CompanyGroup: ${report.companyGroup}`);
  if (report.parseErrors.length) {
    console.log(`\n✗ ${report.parseErrors.length} validation error(s) — see above.`);
  } else {
    console.log('\n✓ All expressions parsed and all references resolved.');
  }
  if (!DO_INSERT) console.log('\n[DRY RUN] No DB writes. Re-run with --insert to apply.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
