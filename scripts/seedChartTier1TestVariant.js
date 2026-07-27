'use strict';

/**
 * TEST/DEMO ONLY — proves the chart company-group variant mechanism
 * (controllers/prowess.controller.js#_buildChartGroup, now routed through
 * lib/screenConfigResolver.js same as lib/financials.js's tables) against
 * the frontend, mirroring scripts/seedTier1TestVariant.js's P&L test but for
 * a chart group instead.
 *
 * Creates financials-style variant charts.pe-ratio.tier1test
 * (variant_of_key: charts.pe-ratio, company_group_slug: tier1) with a
 * relabeled P/E series so it's visually obvious. Any tier1-member ticker
 * (e.g. AARTIIND) will render this variant at GET /api/screener/:symbol/charts;
 * any non-member ticker keeps seeing the base charts.pe-ratio chart.
 *
 * Idempotent. Usage: node scripts/seedChartTier1TestVariant.js
 * Teardown: node scripts/seedChartTier1TestVariant.js --teardown
 */

const prisma = require('../config/prisma');
const screenConfigs = require('../services/admin.screenConfig.service');

const CONFIG_KEY = 'charts.pe-ratio.tier1test';

async function teardown() {
  await prisma.screenConfig.deleteMany({ where: { key: CONFIG_KEY } }); // cascades to items
  console.log('Tore down chart tier1 test variant.');
}

async function main() {
  if (process.argv.includes('--teardown')) return teardown();

  const base = await prisma.screenConfig.findUnique({ where: { key: 'charts.pe-ratio' } });
  if (!base) throw new Error('Base config charts.pe-ratio not found — run scripts/seedScreenConfigs.js first.');

  const existing = await prisma.screenConfig.findUnique({ where: { key: CONFIG_KEY } });
  if (existing) {
    console.log(`ScreenConfig exists: ${CONFIG_KEY}`);
  } else {
    await screenConfigs.createScreenConfig({
      key: CONFIG_KEY,
      label: 'PE Ratio (TIER1 TEST VARIANT)',
      endpoint: base.endpoint,
      decimal_places: base.decimal_places,
      frequency: base.frequency,
      variant_of_key: 'charts.pe-ratio',
      company_group_slug: 'tier1',
    });
    await screenConfigs.addItem(CONFIG_KEY, {
      kpi_abbr: 'PE_DAILY',
      label: 'P/E (TIER1 TEST)',
      display_order: 1,
      series_type: 'line',
    });
    console.log(`Created chart variant: ${CONFIG_KEY} (variant_of_key=charts.pe-ratio, company_group_slug=tier1)`);
    console.log('Note: only P/E is included (Earnings Yield % bar series dropped) — another visible difference from the base chart.');
  }

  console.log('\nDone. Test with a tier1-member ticker, e.g.:');
  console.log('  GET /api/screener/AARTIIND/charts  -> the "PE Ratio" chart group should be labeled "PE Ratio (TIER1 TEST VARIANT)" with only a "P/E (TIER1 TEST)" line, no Earnings Yield bar.');
  console.log('Compare against a non-tier1 ticker (small-cap / no doc coverage) to confirm it still shows the normal base chart.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
