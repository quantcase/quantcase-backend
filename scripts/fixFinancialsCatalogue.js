'use strict';

/**
 * Phase 0.2.1 of the screener-config rework (see the approved plan at
 * ~/.claude/plans/shimmying-skipping-lighthouse.md): closes catalogue gaps
 * that lib/financials.js currently papers over with hand-rolled, admin-invisible
 * fallback logic. This is catalogue-only (Kpi rows + fallback_abbrs) — no
 * financials.js code changes here, that's a separate step (3.3).
 *
 * Idempotent (create-if-missing / patch via the real admin service, so
 * validation + registry cache invalidation run exactly as if an admin used
 * the UI). Usage: node scripts/fixFinancialsCatalogue.js
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
  console.log(`  created: ${abbr} (${fields.formula_expression})`);
  return created;
}

async function ensureFallback(abbr, fallbackAbbrs) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (!existing) throw new Error(`Cannot patch fallback_abbrs — no Kpi "${abbr}"`);
  const merged = [...new Set([...(existing.fallback_abbrs ?? []), ...fallbackAbbrs])];
  if (JSON.stringify(merged) === JSON.stringify(existing.fallback_abbrs ?? [])) {
    console.log(`  fallback already set: ${abbr} -> [${merged.join(', ')}]`);
    return;
  }
  await kpis.updateKpi(abbr, { fallback_abbrs: merged });
  console.log(`  fallback_abbrs: ${abbr} -> [${merged.join(', ')}]`);
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
  console.log('== Enabling raw leaves financials.js already reads directly but the registry cannot see ==');
  await ensureRegistryEnabled('OTH_ASSET_NC');
  await ensureRegistryEnabled('PROV_LT');
  await ensureRegistryEnabled('PROV_ST');

  console.log('\n== Wiring missing fallback_abbrs (replaces inline ?? chains in lib/financials.js) ==');
  await ensureFallback('REV_OP', ['TOTAL_INCOME']);
  await ensureFallback('EPS_BASIC', ['EPS_DILUTED']);

  console.log('\n== New formula Kpis (replace hand-rolled compute in lib/financials.js) ==');
  await ensureKpi('OP_PROFIT', {
    full_form: 'Operating Profit',
    formula_expression: 'REV_OP - TOTAL_OPEX',
    fallback_abbrs: ['EBIT'],
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'REV_OP already falls back to TOTAL_INCOME; falls back to EBIT when REV_OP/TOTAL_OPEX are both unavailable.',
  });
  await ensureKpi('OPM', {
    full_form: 'Operating Profit Margin',
    formula_expression: 'OP_PROFIT / REV_OP * 100',
    unit_label: '%',
    denomination: 'percentage',
  });
  // Replaces financials.js's "sum whichever of these 5 parts are present, but
  // only if at least 2 are non-null" fallback. COALESCE(...,0) is a looser
  // guard (sums even a single present part) — a deliberate, small behavior
  // change flagged in the verification diff, not hidden.
  await ensureKpi('TOTAL_ASSETS_CALC', {
    full_form: 'Total Assets (derived)',
    formula_expression: 'COALESCE(CURR_ASSETS,0) + COALESCE(ASSET_PPE,0) + COALESCE(ASSET_CWIP,0) + COALESCE(INV_NONCURR,0) + COALESCE(OTH_ASSET_NC,0)',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Fallback for TOTAL_ASSETS when not directly reported. Sums whichever components are available (missing ones treated as 0).',
  });
  await ensureKpi('TOTAL_LIAB_CALC', {
    full_form: 'Total Liabilities (derived)',
    formula_expression: 'COALESCE(CURR_LIAB,0) + COALESCE(BORR_TOTAL,0) + COALESCE(PROV_LT,0) + COALESCE(PROV_ST,0)',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Fallback for TOTAL_LIAB when not directly reported. Sums whichever components are available (missing ones treated as 0).',
  });

  console.log('\n== Wiring the two new *_CALC fallbacks onto their parents ==');
  await ensureFallback('TOTAL_ASSETS', ['TOTAL_ASSETS_CALC']);
  await ensureFallback('TOTAL_LIAB', ['TOTAL_LIAB_CALC']);

  console.log('\nDone. ROE / PB_TTM / BORR_TOTAL already have correct catalogue formulas —');
  console.log('the only remaining work for those is the lib/financials.js code swap (task 3.3), not this script.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
