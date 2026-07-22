'use strict';

/**
 * Removes the old silent BFSI formula-swap (KpiRelationship
 * 'variant_for_group': EBIT->EBIT_BFSI, EBIT_MARGIN->EBIT_MARGIN_BFSI,
 * FCF->FCF_BFSI — see the approved plan at
 * ~/.claude/plans/shimmying-skipping-lighthouse.md) and seeds its
 * admin-visible replacement: a BFSI-specific "P&L — Quarterly" ScreenConfig
 * variant with its own KpiGroup tree, wired via
 * ScreenConfig.variant_of_key/company_group_slug (resolved by
 * lib/financials.js#_resolveScreenConfig). Also patches the 'bfsi'
 * CompanyGroup's filter_config.industries — it only listed the short-form
 * "NBFC"/"Dep, Clrng Houses and Other Interm" strings, but
 * earnings_calls.basic_industry actually stores the long forms
 * ("Non Banking Financial Company (NBFC)" / "Depositories, Clearing Houses
 * and Other Intermediaries") for most rows — without this fix
 * isCompanyInGroup('bfsi') silently never matches most NBFCs.
 *
 * Row structure/formulas verified against real HDFCBANK data (Prowess name
 * "H D F C Bank Ltd.") — see the plan file for the full derivation:
 *   Revenue=REV_OP, Interest=FIN_COST, Expenses=EMP_EXP+OTH_EXP (new:
 *   BFSI_OPEX), Financing Profit=REV_OP-FIN_COST-BFSI_OPEX (new:
 *   FINANCING_PROFIT), Financing Margin %=FINANCING_PROFIT/REV_OP*100 (new:
 *   FINANCING_MARGIN), Other Income=OTH_INC, Depreciation=DEP_AMORT,
 *   Profit before tax=PBT (raw, not derived -- avoids a reconciliation drift
 *   found in older-vintage rows), Tax %=TAX_EXP/PBT*100 (new: TAX_PCT),
 *   Net Profit=PAT, EPS in Rs=EPS_BASIC.
 *
 * Idempotent (upsert-style) — safe to re-run. Usage: node scripts/seedBfsiPnlGroup.js
 */

const prisma = require('../config/prisma');
const kpis = require('../services/admin.kpis.service');
const screenConfigs = require('../services/admin.screenConfig.service');
const { invalidateRegistryCache } = require('../utils/formulaRegistry/registryCache');

async function removeVariantForGroupRelationships() {
  console.log('== Removing legacy variant_for_group KpiRelationship rows ==');
  const { count } = await prisma.kpiRelationship.deleteMany({ where: { relationship_type: 'variant_for_group' } });
  console.log(`  deleted ${count} row(s)`);
}

async function patchBfsiCompanyGroupIndustries() {
  console.log('== Patching bfsi CompanyGroup filter_config.industries ==');
  const group = await prisma.companyGroup.findUnique({ where: { slug: 'bfsi' } });
  if (!group) {
    console.log('  !! no CompanyGroup with slug "bfsi" -- skipping');
    return;
  }
  const missing = [
    'Non Banking Financial Company (NBFC)',
    'Depositories, Clearing Houses and Other Intermediaries',
  ];
  const industries = group.filter_config?.industries ?? [];
  const toAdd = missing.filter((i) => !industries.includes(i));
  if (!toAdd.length) {
    console.log('  already up to date');
    return;
  }
  await prisma.companyGroup.update({
    where: { slug: 'bfsi' },
    data: { filter_config: { ...group.filter_config, industries: [...industries, ...toAdd] } },
  });
  console.log(`  added: ${toAdd.join(', ')}`);
}

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

// EMP_EXP/OTH_EXP are real raw Prowess-ingested columns (already referenced
// by utils/formulaRegistry/seriesResolver.js's SOURCE_ABBRS) that were never
// flipped registry_enabled -- same bucket scripts/addChartsPrerequisiteKpis.js
// already fixed for COST_MAT/PURCH_STOCK/INV_CHG, just missed for these two.
// Without this, BFSI_OPEX (and the pre-existing EBIT_BFSI formula, which
// references both) can never resolve to anything but null.
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

async function ensureBfsiKpis() {
  console.log('== Enabling EMP_EXP/OTH_EXP raw leaves (needed by BFSI_OPEX) ==');
  await ensureRegistryEnabled('EMP_EXP');
  await ensureRegistryEnabled('OTH_EXP');

  console.log('== Creating BFSI P&L formula Kpis ==');
  // Dependency order matters -- each formula below is validated against
  // already-existing abbrs at creation time.
  await ensureKpi('BFSI_OPEX', {
    full_form: 'Operating Expenses (BFSI)',
    formula_expression: 'EMP_EXP + OTH_EXP',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Employee cost + other opex, excluding interest expended and provisions -- the "Expenses" row on a bank/NBFC P&L (generic TOTAL_OPEX conflates FIN_COST+PROV_CONT in for BFSI companies, which is why this exists separately).',
  });
  await ensureKpi('FINANCING_PROFIT', {
    full_form: 'Financing Profit',
    formula_expression: 'REV_OP - FIN_COST - BFSI_OPEX',
    unit_label: 'Cr',
    denomination: 'rupee',
    description: 'Core banking profit: interest earned less interest expended and opex, before other income/provisions/tax.',
  });
  await ensureKpi('FINANCING_MARGIN', {
    full_form: 'Financing Margin %',
    formula_expression: 'FINANCING_PROFIT / REV_OP * 100',
    unit_label: '%',
    denomination: 'percentage',
    description: 'Financing Profit as a percentage of Revenue (interest earned).',
  });
  await ensureKpi('TAX_PCT', {
    full_form: 'Tax %',
    formula_expression: 'TAX_EXP / PBT * 100',
    unit_label: '%',
    denomination: 'percentage',
    description: 'Effective tax rate: tax expense as a percentage of profit before tax.',
  });
}

const BFSI_PNL_QUARTERLY_ITEMS = [
  { kpi_abbr: 'REV_OP',             label: 'Revenue' },
  { kpi_abbr: 'FIN_COST',           label: 'Interest' },
  { kpi_abbr: 'BFSI_OPEX',          label: 'Expenses' },
  { kpi_abbr: 'FINANCING_PROFIT',   label: 'Financing Profit' },
  { kpi_abbr: 'FINANCING_MARGIN',   label: 'Financing Margin %' },
  { kpi_abbr: 'OTH_INC',            label: 'Other Income' },
  { kpi_abbr: 'DEP_AMORT',          label: 'Depreciation' },
  { kpi_abbr: 'PBT',                label: 'Profit Before Tax' },
  { kpi_abbr: 'TAX_PCT',            label: 'Tax %' },
  { kpi_abbr: 'PAT',                label: 'Net Profit' },
  { kpi_abbr: 'EPS_BASIC',          label: 'EPS in Rs' },
];

async function ensureBfsiKpiGroup() {
  console.log('== Creating pnl-statement-bfsi--quarterly KpiGroup tree ==');
  const rootSlug = 'pnl-statement-bfsi--quarterly';
  let branch = await prisma.kpiGroup.findUnique({ where: { slug: rootSlug } });
  if (!branch) {
    branch = await prisma.kpiGroup.create({
      data: { slug: rootSlug, label: 'Quarterly (BFSI)', parent_id: null, kpi_abbr: null, display_order: 0 },
    });
    console.log(`  created root: ${rootSlug}`);
  } else {
    console.log(`  root exists: ${rootSlug}`);
  }

  let order = 1;
  for (const item of BFSI_PNL_QUARTERLY_ITEMS) {
    const slug = `${rootSlug}--${item.kpi_abbr.toLowerCase().replace(/_/g, '-')}`;
    const existing = await prisma.kpiGroup.findUnique({ where: { slug } });
    if (existing) {
      console.log(`    exists: ${item.kpi_abbr}`);
    } else {
      await prisma.kpiGroup.create({
        data: { slug, label: item.label, parent_id: branch.id, kpi_abbr: item.kpi_abbr, display_order: order },
      });
      console.log(`    created: ${item.kpi_abbr} (${item.label})`);
    }
    order += 1;
  }
  return rootSlug;
}

async function ensureBfsiScreenConfigVariant(kpiGroupSlug) {
  console.log('== Creating financials.pnl.quarterly.bfsi ScreenConfig variant ==');
  const key = 'financials.pnl.quarterly.bfsi';
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (existing) {
    console.log(`  exists: ${key}`);
    return existing;
  }
  const base = await prisma.screenConfig.findUnique({ where: { key: 'financials.pnl.quarterly' } });
  const created = await screenConfigs.createScreenConfig({
    key,
    label: 'P&L — Quarterly (BFSI)',
    endpoint: 'GET /api/screener/:symbol/financials',
    periods_shown: base?.periods_shown ?? null,
    decimal_places: base?.decimal_places ?? 2,
    kpi_group_slug: kpiGroupSlug,
    variant_of_key: 'financials.pnl.quarterly',
    company_group_slug: 'bfsi',
  });
  console.log(`  created: ${key}`);
  return created;
}

async function main() {
  await removeVariantForGroupRelationships();
  await patchBfsiCompanyGroupIndustries();
  await ensureBfsiKpis();
  const kpiGroupSlug = await ensureBfsiKpiGroup();
  await ensureBfsiScreenConfigVariant(kpiGroupSlug);
  invalidateRegistryCache();
  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
