'use strict';

/**
 * TEST/DEMO ONLY — proves out the same company-group-scoped ScreenConfig
 * variant mechanism piloted for BFSI (scripts/seedBfsiPnlGroup.js), but
 * pinned to the pre-existing `tier1` CompanyGroup instead, so it can be
 * verified against the frontend without touching the real BFSI pilot.
 *
 * Clones financials.pnl.quarterly's KpiGroup row set, drops "Other Income"
 * and relabels "Sales" so the difference is visually obvious, and creates a
 * ScreenConfig variant (financials.pnl.quarterly.tier1test) scoped to
 * company_group_slug: 'tier1'. Any tier1-member ticker (e.g. AARTIIND) will
 * render this variant at GET /api/screener/:symbol/financials; any
 * non-member ticker keeps seeing the base financials.pnl.quarterly table.
 *
 * Idempotent. Usage: node scripts/seedTier1TestVariant.js
 * Teardown: node scripts/seedTier1TestVariant.js --teardown
 */

const kpiGroups    = require('../services/admin.kpiGroups.service');
const screenConfigs = require('../services/admin.screenConfig.service');
const prisma        = require('../config/prisma');

const GROUP_SLUG  = 'pnl-statement-tier1test--quarterly';
const CONFIG_KEY  = 'financials.pnl.quarterly.tier1test';

// Same rows as pnl-statement--quarterly, minus OTH_INC, with Sales relabeled.
const ROWS = [
  { slug: `${GROUP_SLUG}--rev-op`,     label: 'Sales (TIER1 TEST VARIANT)', kpi_abbr: 'REV_OP',     display_order: 1 },
  { slug: `${GROUP_SLUG}--total-opex`, label: 'Expenses',                   kpi_abbr: 'TOTAL_OPEX', display_order: 2 },
  { slug: `${GROUP_SLUG}--op-profit`,  label: 'Operating Profit',           kpi_abbr: 'OP_PROFIT',  display_order: 3 },
  { slug: `${GROUP_SLUG}--opm`,        label: 'OPM %',                      kpi_abbr: 'OPM',        display_order: 4 },
  { slug: `${GROUP_SLUG}--fin-cost`,   label: 'Interest',                   kpi_abbr: 'FIN_COST',   display_order: 5 },
  { slug: `${GROUP_SLUG}--dep-amort`,  label: 'Depreciation',               kpi_abbr: 'DEP_AMORT',  display_order: 6 },
  { slug: `${GROUP_SLUG}--pbt`,        label: 'Profit Before Tax',          kpi_abbr: 'PBT',        display_order: 7 },
  { slug: `${GROUP_SLUG}--pat`,        label: 'Net Profit',                 kpi_abbr: 'PAT',        display_order: 8 },
  { slug: `${GROUP_SLUG}--eps-basic`,  label: 'EPS',                        kpi_abbr: 'EPS_BASIC',  display_order: 9 },
  // Other Income intentionally dropped — proves the row set can genuinely
  // differ per company group, not just labels.
];

async function teardown() {
  await prisma.screenConfig.deleteMany({ where: { key: CONFIG_KEY } });
  await prisma.kpiGroup.deleteMany({ where: { slug: GROUP_SLUG } }); // cascades to children
  console.log('Tore down tier1 test variant.');
}

async function main() {
  if (process.argv.includes('--teardown')) return teardown();

  let group = await prisma.kpiGroup.findUnique({ where: { slug: GROUP_SLUG } });
  if (!group) {
    group = await kpiGroups.createKpiGroup({ slug: GROUP_SLUG, label: 'Quarterly (Tier1 Test)' });
    console.log(`Created KpiGroup container: ${GROUP_SLUG}`);
  } else {
    console.log(`KpiGroup container exists: ${GROUP_SLUG}`);
  }

  for (const row of ROWS) {
    const existing = await prisma.kpiGroup.findUnique({ where: { slug: row.slug } });
    if (existing) {
      console.log(`  leaf exists: ${row.slug}`);
      continue;
    }
    await kpiGroups.createKpiGroup({ ...row, parent_id: group.id });
    console.log(`  created leaf: ${row.slug} (${row.label})`);
  }

  const existingConfig = await prisma.screenConfig.findUnique({ where: { key: CONFIG_KEY } });
  if (existingConfig) {
    console.log(`ScreenConfig exists: ${CONFIG_KEY}`);
  } else {
    await screenConfigs.createScreenConfig({
      key: CONFIG_KEY,
      label: 'P&L — Quarterly (Tier1 Test Variant)',
      endpoint: 'GET /api/screener/:symbol/financials',
      decimal_places: 2,
      frequency: 'quarterly',
      kpi_group_slug: GROUP_SLUG,
      variant_of_key: 'financials.pnl.quarterly',
      company_group_slug: 'tier1',
    });
    console.log(`Created ScreenConfig variant: ${CONFIG_KEY} (variant_of_key=financials.pnl.quarterly, company_group_slug=tier1)`);
  }

  console.log('\nDone. Test with a tier1-member ticker, e.g.:');
  console.log('  GET /api/screener/AARTIIND/financials  -> standardized.quarterly should show "Sales (TIER1 TEST VARIANT)" and NO "Other Income" row');
  console.log('Compare against a non-tier1 ticker (small-cap / no doc coverage) to confirm it still shows the normal table.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
