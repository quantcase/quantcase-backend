'use strict';

/**
 * Phase 1.2 of the screener-config rework (see the approved plan at
 * ~/.claude/plans/shimmying-skipping-lighthouse.md): seeds ScreenConfig/
 * ScreenConfigItem rows reproducing today's hardcoded row lists in
 * lib/financials.js / controllers/prowess.controller.js#getCharts /
 * services/tickerMetrics.service.js — exact order, exact highlight/
 * expandable flags, exact decimal_places overrides where the current code's
 * rounding isn't the 2dp default (only OPM, which uses integer pct()).
 *
 * Depends on every Kpi row from fixFinancialsCatalogue.js and
 * addChartsPrerequisiteKpis.js already existing — run those first.
 *
 * Idempotent, uses the real admin service (validation, _assertKpiExists).
 * Usage: node scripts/seedScreenConfigs.js
 */

const screenConfigs = require('../services/admin.screenConfig.service');
const prisma = require('../config/prisma');

async function ensureConfig(key, fields) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (existing) {
    console.log(`  config exists: ${key}`);
    return existing;
  }
  const created = await screenConfigs.createScreenConfig({ key, ...fields });
  console.log(`  created config: ${key}`);
  return created;
}

async function ensureItems(key, items) {
  const config = await prisma.screenConfig.findUnique({ where: { key }, include: { items: true } });
  const existingAbbrs = new Set(config.items.map(i => i.kpi_abbr));
  for (const item of items) {
    if (existingAbbrs.has(item.kpi_abbr)) {
      console.log(`    item exists: ${item.kpi_abbr}`);
      continue;
    }
    await screenConfigs.addItem(key, item);
    console.log(`    added item: ${item.kpi_abbr}`);
  }
}

// ── Financials — Profit & Loss ────────────────────────────────────────────────

const PNL_ANNUAL_ITEMS = [
  { kpi_abbr: 'REV_OP',     label: 'Sales',             display_order: 1 },
  { kpi_abbr: 'TOTAL_OPEX', label: 'Expenses',          display_order: 2 },
  { kpi_abbr: 'OP_PROFIT',  label: 'Operating Profit',  display_order: 3, highlight: true },
  { kpi_abbr: 'OPM',        label: 'OPM %',             display_order: 4, decimal_places: 0 },
  { kpi_abbr: 'PBT',        label: 'Profit Before Tax', display_order: 5 },
  { kpi_abbr: 'PAT',        label: 'Net Profit',        display_order: 6, highlight: true },
  { kpi_abbr: 'EPS_BASIC',  label: 'EPS',               display_order: 7 },
];

const PNL_QUARTERLY_ITEMS = [
  { kpi_abbr: 'REV_OP',      label: 'Sales',              display_order: 1,  expandable: true },
  { kpi_abbr: 'TOTAL_OPEX',  label: 'Expenses',           display_order: 2,  expandable: true },
  { kpi_abbr: 'OP_PROFIT',   label: 'Operating Profit',   display_order: 3,  highlight: true },
  { kpi_abbr: 'OPM',         label: 'OPM %',               display_order: 4,  decimal_places: 0 },
  { kpi_abbr: 'OTH_INC',     label: 'Other Income',       display_order: 5 },
  { kpi_abbr: 'FIN_COST',    label: 'Interest',           display_order: 6 },
  { kpi_abbr: 'DEP_AMORT',   label: 'Depreciation',       display_order: 7 },
  { kpi_abbr: 'PBT',         label: 'Profit Before Tax',  display_order: 8,  highlight: true },
  { kpi_abbr: 'PAT',         label: 'Net Profit',         display_order: 9,  highlight: true },
  { kpi_abbr: 'EPS_BASIC',   label: 'EPS',                display_order: 10 },
];

// ── Financials — Balance Sheet (same row set for annual & quarterly) ─────────

const BALANCE_SHEET_ITEMS = [
  { kpi_abbr: 'EQ_SHARE_CAP', label: 'Equity Capital',    display_order: 1 },
  { kpi_abbr: 'RES_SURPLUS',  label: 'Reserves',          display_order: 2 },
  { kpi_abbr: 'BORR_TOTAL',   label: 'Borrowings',        display_order: 3 },
  { kpi_abbr: 'TOTAL_LIAB',   label: 'Total Liabilities', display_order: 4, highlight: true },
  { kpi_abbr: 'ASSET_PPE',    label: 'Fixed Assets',      display_order: 5 },
  { kpi_abbr: 'ASSET_CWIP',   label: 'CWIP',              display_order: 6 },
  { kpi_abbr: 'INV_NONCURR',  label: 'Investments',       display_order: 7 },
  { kpi_abbr: 'TOTAL_ASSETS', label: 'Total Assets',      display_order: 8, highlight: true },
];

// ── Financials — Cash Flow (same row set for annual & quarterly) ─────────────

const CASHFLOW_ITEMS = [
  { kpi_abbr: 'CFO', label: 'Cash from Operations', display_order: 1, highlight: true },
  { kpi_abbr: 'CFI', label: 'Cash from Investing',  display_order: 2 },
  { kpi_abbr: 'CFF', label: 'Cash from Financing',  display_order: 3 },
];

// ── Charts ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('== Financials: Profit & Loss ==');
  await ensureConfig('financials.pnl.annual', { label: 'P&L — Annual', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.pnl.annual', PNL_ANNUAL_ITEMS);
  await ensureConfig('financials.pnl.quarterly', { label: 'P&L — Quarterly', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.pnl.quarterly', PNL_QUARTERLY_ITEMS);

  console.log('\n== Financials: Balance Sheet ==');
  await ensureConfig('financials.balance-sheet.annual', { label: 'Balance Sheet — Annual', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.balance-sheet.annual', BALANCE_SHEET_ITEMS);
  await ensureConfig('financials.balance-sheet.quarterly', { label: 'Balance Sheet — Quarterly', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.balance-sheet.quarterly', BALANCE_SHEET_ITEMS);

  console.log('\n== Financials: Cash Flow ==');
  await ensureConfig('financials.cashflow.annual', { label: 'Cash Flow — Annual', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.cashflow.annual', CASHFLOW_ITEMS);
  await ensureConfig('financials.cashflow.quarterly', { label: 'Cash Flow — Quarterly', endpoint: 'GET /api/screener/:symbol/financials', decimal_places: 2 });
  await ensureItems('financials.cashflow.quarterly', CASHFLOW_ITEMS);

  console.log('\n== Charts ==');
  await ensureConfig('charts.pe-ratio', { label: 'PE Ratio', endpoint: 'GET /api/screener/:symbol/charts', decimal_places: 2 });
  await ensureItems('charts.pe-ratio', [
    // EARNINGS_YIELD_DAILY (100/PE_DAILY), not EARNINGS_YIELD (TTM_EPS/PRICE*100)
    // -- the latter depends on TTM_EPS, an aggregate/quarterly-pinned Kpi, so it
    // hits the same historical-index null wall as EV_EBITDA/PB_TTM/MCAP_SALES.
    // EARNINGS_YIELD_DAILY is a pure daily transform of PE_DAILY, so it resolves
    // a real historical series for the chart bar.
    { kpi_abbr: 'EARNINGS_YIELD_DAILY', label: 'Earnings Yield %', display_order: 1, series_type: 'bar' },
    { kpi_abbr: 'PE_DAILY',             label: 'P/E',              display_order: 2, series_type: 'line' },
  ]);

  await ensureConfig('charts.sales-margin', { label: 'Sales & Margin', endpoint: 'GET /api/screener/:symbol/charts', decimal_places: 2 });
  await ensureItems('charts.sales-margin', [
    { kpi_abbr: 'REV_OP', label: 'Quarter Sales (Cr)', display_order: 1, series_type: 'bar' },
    { kpi_abbr: 'GPM',    label: 'GPM %',               display_order: 2, series_type: 'line' },
    { kpi_abbr: 'OPM',    label: 'OPM %',               display_order: 3, series_type: 'line' },
    { kpi_abbr: 'NPM',    label: 'NPM %',               display_order: 4, series_type: 'line' },
  ]);

  // The ratio lines below have no historical series yet (mixed daily/quarterly
  // formulas, see resolveFormulaSeries's docs) -- seeded anyway per the "no
  // CSV fallback, null is fine" decision: same code path as every other
  // chart group, they'll just return an empty series until admin ingests
  // quarterly-aligned data for them. Their bar items (current-value-only
  // Kpis) resolve fine today since bars don't need historical alignment the
  // same way -- see prowess.controller.js#getCharts for how bars are built.
  await ensureConfig('charts.ev-ebitda', { label: 'EV/EBITDA', endpoint: 'GET /api/screener/:symbol/charts', decimal_places: 2 });
  await ensureItems('charts.ev-ebitda', [
    { kpi_abbr: 'ENTERPRISE_VALUE', label: 'Enterprise Value (Cr)', display_order: 1, series_type: 'bar' },
    { kpi_abbr: 'EV_EBITDA',        label: 'EV/EBITDA',             display_order: 2, series_type: 'line' },
  ]);

  await ensureConfig('charts.price-to-book', { label: 'Price to Book', endpoint: 'GET /api/screener/:symbol/charts', decimal_places: 2 });
  await ensureItems('charts.price-to-book', [
    { kpi_abbr: 'PRICE',  label: 'Stock Price (₹)', display_order: 1, series_type: 'bar' },
    { kpi_abbr: 'PB_TTM', label: 'P/B',             display_order: 2, series_type: 'line' },
  ]);

  await ensureConfig('charts.mcap-sales', { label: 'Market Cap / Sales', endpoint: 'GET /api/screener/:symbol/charts', decimal_places: 2 });
  await ensureItems('charts.mcap-sales', [
    { kpi_abbr: 'MCAP_SNAPSHOT', label: 'Market Cap (Cr)', display_order: 1, series_type: 'bar' },
    { kpi_abbr: 'MCAP_SALES',    label: 'Mcap/Sales',      display_order: 2, series_type: 'line' },
  ]);

  console.log('\n== Peers ==');
  await ensureConfig('peers.columns', { label: 'Peer Comparison Columns', endpoint: 'GET /api/screener/:symbol/peers', decimal_places: 2 });
  await ensureItems('peers.columns', [
    { kpi_abbr: 'PRICE',         label: 'CMP',           display_order: 0 },
    { kpi_abbr: 'PE_TTM',        label: 'P/E',           display_order: 1 },
    { kpi_abbr: 'MCAP_SNAPSHOT', label: 'Market Cap',    display_order: 2 },
    { kpi_abbr: 'ROCE',          label: 'ROCE %',        display_order: 3 },
    { kpi_abbr: 'REV_OP',        label: 'Sales (Qtr)',   display_order: 4 },
    { kpi_abbr: 'REV_CAGR',      label: 'Sales Var %',   display_order: 5 },
    { kpi_abbr: 'PAT',           label: 'Net Profit (Qtr)', display_order: 6 },
    { kpi_abbr: 'PAT_CAGR',      label: 'Profit Var %',  display_order: 7 },
    // DIVIDEND_YIELD is registry_enabled but has zero source rows anywhere
    // in prowess_values_new (verified) -- resolves null until real data is
    // ingested through the normal Prowess pipeline. No CSV fallback.
    { kpi_abbr: 'DIVIDEND_YIELD', label: 'Div Yield %',  display_order: 8 },
  ]);

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
