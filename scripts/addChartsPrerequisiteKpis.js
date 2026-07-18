'use strict';

/**
 * Phase 0.2.2 of the screener-config rework (see the approved plan at
 * ~/.claude/plans/shimmying-skipping-lighthouse.md): registers the Kpi rows
 * charts.pe-ratio / charts.sales-margin / charts.ev-ebitda /
 * charts.price-to-book / charts.mcap-sales need. No CSV involved anywhere —
 * PE_DAILY/MCAP_SNAPSHOT are raw daily leaves backed by nse_equity_new
 * (already-existing columns, just newly exposed to the registry via
 * resolutionContext.js's new daily-series support); everything else is a
 * plain arithmetic formula over abbrs that already exist.
 *
 * Idempotent, uses the real admin service (validation + registry cache
 * invalidation). Usage: node scripts/addChartsPrerequisiteKpis.js
 */

const kpis = require('../services/admin.kpis.service');
const prisma = require('../config/prisma');

async function ensureKpi(abbr, fields) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (existing) {
    console.log(`  exists: ${abbr}`);
    return existing;
  }
  const created = await kpis.createKpi({ abbr, ...fields });
  console.log(`  created: ${abbr} (${fields.formula_expression ?? 'raw'})`);
  return created;
}

/**
 * For an abbr that already exists as an unconfigured `source: 'transcript'`
 * dedup-pipeline stub (registry_enabled: false, no formula) whose full_form
 * was manually verified to describe the SAME real-world concept — configure
 * it in place rather than creating a duplicate (abbr is globally unique).
 * Never call this without checking the existing row's full_form/kpi_type
 * first — 'EV' turned out to mean "Electric Vehicle" on that pipeline (a
 * real collision, NOT reused — see ENTERPRISE_VALUE below instead), while
 * 'EV_EBITDA'/'ENTERPRISE_VALUE' genuinely matched.
 */
async function configureExistingStub(abbr, fields) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (!existing) throw new Error(`configureExistingStub("${abbr}") — no such row exists.`);
  if (existing.formula_expression) {
    console.log(`  already configured: ${abbr}`);
    return existing;
  }
  const updated = await kpis.updateKpi(abbr, fields);
  console.log(`  configured existing stub: ${abbr} (${fields.formula_expression})`);
  return updated;
}

async function ensureRegistryEnabled(abbr) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (!existing) throw new Error(`No Kpi "${abbr}" to enable.`);
  if (existing.registry_enabled) {
    console.log(`  already registry_enabled: ${abbr}`);
    return;
  }
  await kpis.updateKpi(abbr, {});
  console.log(`  registry_enabled -> true: ${abbr}`);
}

async function main() {
  console.log('== Enabling COGS-component raw leaves (already used by seriesResolver.js\'s SOURCE_ABBRS) ==');
  await ensureRegistryEnabled('COST_MAT');
  await ensureRegistryEnabled('PURCH_STOCK');
  await ensureRegistryEnabled('INV_CHG');

  console.log('\n== New raw daily leaves, backed by nse_equity_new (no CSV involved) ==');
  await ensureKpi('PE_DAILY', {
    full_form: 'P/E Ratio (daily, as reported by NSE)',
    frequency: 'daily',
    unit_label: 'x',
    denomination: 'ratio',
    description: 'Raw daily P/E from nse_equity_new.pe — one row per trading day.',
  });
  await ensureKpi('MCAP_SNAPSHOT', {
    full_form: 'Market Capitalisation (daily snapshot)',
    frequency: 'daily',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Raw daily market cap from nse_equity_new.market_cap_cr — the reported snapshot value, not the PRICE*EQ_SHARE_CAP/10 formula MARKET_CAP_CR uses.',
  });

  console.log('\n== New quarterly/derived formulas ==');
  await ensureKpi('TTM_REV_OP', {
    full_form: 'Revenue (TTM)',
    formula_expression: 'SUM(REV_OP, 4)',
    frequency: 'quarterly',
    unit_label: 'Cr',
    denomination: 'rupee',
  });
  // NOT named 'EV' -- that abbr already exists on the transcript-dedup
  // pipeline meaning "Electric Vehicle" (full_form confirmed), a genuine
  // semantic collision. 'ENTERPRISE_VALUE' also pre-existed as a dedup stub,
  // but its full_form already correctly said "Enterprise Value" -- safe to
  // configure in place.
  await configureExistingStub('ENTERPRISE_VALUE', {
    formula_expression: 'MCAP_SNAPSHOT + BORR_TOTAL - CASH_EQUIV',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Uses the daily market-cap snapshot (MCAP_SNAPSHOT), not the formula-derived MARKET_CAP_CR.',
  });
  // EV_EBITDA's existing dedup stub's full_form already said "Enterprise
  // Value to EBITDA" -- same safe-to-configure case.
  await configureExistingStub('EV_EBITDA', {
    formula_expression: 'ENTERPRISE_VALUE / TTM_EBITDA',
    unit_label: 'x',
    denomination: 'ratio',
  });
  await ensureKpi('MCAP_SALES', {
    full_form: 'Market Cap / Sales',
    formula_expression: 'MCAP_SNAPSHOT / TTM_REV_OP',
    unit_label: 'x',
    denomination: 'ratio',
  });
  // Distinct from MCAP_SALES -- EV/Revenue uses enterprise value, not just
  // market cap. Needed for lib/financials.js's _buildValuation.evToRevenue.
  await ensureKpi('EV_REVENUE', {
    full_form: 'EV/Revenue',
    formula_expression: 'ENTERPRISE_VALUE / TTM_REV_OP',
    unit_label: 'x',
    denomination: 'ratio',
  });
  await ensureKpi('EARNINGS_YIELD', {
    full_form: 'Earnings Yield',
    formula_expression: 'TTM_EPS / PRICE * 100',
    unit_label: '%',
    denomination: 'percentage',
    description: 'TTM_EPS/PRICE*100, not 1/PE_TTM — avoids inverting a near-zero PE.',
  });
  await ensureKpi('GPM', {
    full_form: 'Gross Profit Margin',
    // COALESCE each cost component to 0 -- PURCH_STOCK in particular is
    // frequently absent quarterly (e.g. zero rows for Reliance Industries,
    // a manufacturer with no purchased-stock-for-resale line item); a plain
    // subtraction would null-propagate GPM entirely whenever any one
    // component is missing/inapplicable, same tradeoff already made for
    // TOTAL_ASSETS_CALC/TOTAL_LIAB_CALC in fixFinancialsCatalogue.js.
    formula_expression: '(REV_OP - COALESCE(COST_MAT,0) - COALESCE(PURCH_STOCK,0) - COALESCE(INV_CHG,0)) / REV_OP * 100',
    unit_label: '%',
    denomination: 'percentage',
  });
  await ensureKpi('NPM', {
    full_form: 'Net Profit Margin',
    formula_expression: 'PAT / REV_OP * 100',
    unit_label: '%',
    denomination: 'percentage',
  });

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
