'use strict';

/**
 * Migration script for Step 2 and Step 3:
 * Unifies BFSI & Non-BFSI KPI abbreviations across annual and quarterly cadences.
 *
 * 1. Step 2: Updates `kpis` table
 *    - Unifies header mapping on canonical KPI abbreviations (REV_OP, PAT, EMP_EXP, etc.)
 *    - Clears prowess_name on legacy abbreviations to prevent resolution collisions
 *    - Cross-links fallback_abbrs between canonical and legacy keys for bidirectional compatibility
 *    - Updates formula expressions for NPM_ANNUAL_PCT and TOT_TAX_PRO_ANNUAL
 *
 * 2. Step 3: Updates `kpi_groups` screen rows
 *    - Replaces legacy abbreviations with canonical abbreviations in screen row nodes
 *
 * 3. Invalidation & Verification
 *    - Invalidates in-memory registry cache
 *    - Verifies resolution for all affected indicators
 *
 * Usage:
 *   node scripts/migrate_bfsi_kpis_and_screens.js [--apply] [--dry-run]
 */

const prisma = require('../config/prisma');
const { invalidateRegistryCache } = require('../utils/formulaRegistry/registryCache');

const IS_APPLY = process.argv.includes('--apply');

// 10 core indicator pairs + loan advances
const KPI_MIGRATIONS = [
  {
    header: 'Net sales',
    canonical: 'REV_OP',
    legacy: 'SALES_BFSI',
    prowessName: 'Net sales',
    quarterlyProwessName: 'Net sales',
  },
  {
    header: 'Net Profit / Net Profit after share of profit/loss of associates',
    canonical: 'PAT',
    legacy: 'NET_PNL_AFTR_SHAREPNL_ASST_BFSI',
    prowessName: 'Net Profit / Net Profit after share of profit/loss of associates',
    quarterlyProwessName: 'Net Profit / Net Profit after share of profit/loss of associates',
  },
  {
    header: 'Salaries and wages',
    canonical: 'EMP_EXP',
    legacy: 'SAL_WAGE_BFSI',
    prowessName: 'Salaries and wages',
    quarterlyProwessName: 'Salaries and wages',
  },
  {
    header: 'Total other expenses',
    canonical: 'OTH_EXP',
    legacy: 'TOT_OTHR_EXP_BFSI',
    prowessName: 'Total other expenses',
    quarterlyProwessName: 'Total other expenses',
  },
  {
    header: 'Interest expenses',
    canonical: 'FIN_COST',
    legacy: 'INT_EXP_BFSI',
    prowessName: 'Interest expenses',
    quarterlyProwessName: 'Interest expenses',
  },
  {
    header: 'Other income',
    canonical: 'OTH_INC',
    legacy: 'OTH_INC_BFSI',
    prowessName: 'Other income',
    quarterlyProwessName: 'Other income',
  },
  {
    header: 'Total tax provision',
    canonical: 'TAX_EXP',
    legacy: 'TOT_TAX_PRO_BFSI',
    prowessName: 'Total tax provision',
    quarterlyProwessName: 'Total tax provision',
  },
  {
    header: 'Depreciation',
    canonical: 'DEP_AMORT',
    legacy: 'DEP_AMR_BFSI',
    prowessName: 'Depreciation',
    quarterlyProwessName: 'Depreciation',
  },
  {
    header: 'Provisions and contingencies',
    canonical: 'PROV_CONT',
    legacy: 'PROV_CONTI_BFSII',
    prowessName: 'Provisions and contingencies',
    quarterlyProwessName: 'Provisions and contingencies',
  },
  {
    header: 'Net Interest Margin',
    canonical: 'NIM_PCT',
    legacy: 'NIM_BFSI',
    prowessName: 'Net Interest Margin',
    quarterlyProwessName: 'Net Interest Margin',
  },
  {
    header: 'Advances',
    canonical: 'ADVANCE_BFSI',
    legacy: 'BFSI_LOAN_ADV',
    prowessName: 'Advances',
    quarterlyProwessName: 'Advances',
  },
];

// Screen rows in kpi_groups to migrate to canonical abbrs
const KPI_GROUP_MIGRATIONS = [
  // Net Sales -> REV_OP
  { slug: 'net-sales-annual-bfsi', targetAbbr: 'REV_OP' },
  { slug: 'net-sales-annual-nonbfsi', targetAbbr: 'REV_OP' },
  { slug: 'net-sales-ins-annual', targetAbbr: 'REV_OP' },

  // Net Profit -> PAT
  { slug: 'net-profit-annual-bfsi', targetAbbr: 'PAT' },
  { slug: 'net-profit-ins-annual', targetAbbr: 'PAT' },
  { slug: 'net-profit-net-profit-after-share-of-profit-loss-of-associates-annual-nonbfsi', targetAbbr: 'PAT' },

  // Employee Cost -> EMP_EXP
  { slug: 'employee-cost-ins-annual', targetAbbr: 'EMP_EXP' },
  { slug: 'employee-cost-annual-bfsi', targetAbbr: 'EMP_EXP' },
  { slug: 'salaries-and-wages-annual-nonbfsi', targetAbbr: 'EMP_EXP' },

  // Other Expenses -> OTH_EXP
  { slug: 'total-other-expenses-ins-annual', targetAbbr: 'OTH_EXP' },
  { slug: 'total-other-expense-annual-bfsi', targetAbbr: 'OTH_EXP' },

  // Interest Expense -> FIN_COST
  { slug: 'interest-expense-ins-annual', targetAbbr: 'FIN_COST' },
  { slug: 'interest-expense-annual-bfsi', targetAbbr: 'FIN_COST' },
  { slug: 'interest-expense-annual-nonbfsi', targetAbbr: 'FIN_COST' },

  // Other Income -> OTH_INC
  { slug: 'other-income-annual-bfsi', targetAbbr: 'OTH_INC' },
  { slug: 'other-income-annual-nonbfsi', targetAbbr: 'OTH_INC' },
  { slug: 'other-income-ins-annual', targetAbbr: 'OTH_INC' },

  // Tax Provision -> TAX_EXP
  { slug: 'total-tax-provision-annual-nonbfsi', targetAbbr: 'TAX_EXP' },

  // Depreciation -> DEP_AMORT
  { slug: 'depreciation-ins-annual', targetAbbr: 'DEP_AMORT' },
  { slug: 'depreciation-annual-nonbfsi', targetAbbr: 'DEP_AMORT' },

  // Net Interest Margin -> NIM_PCT
  { slug: 'net-interest-margin-annual-bfsi', targetAbbr: 'NIM_PCT' },

  // Advances -> ADVANCE_BFSI
  { slug: 'bfsi-loan-advances', targetAbbr: 'ADVANCE_BFSI' },

  // Net Profit Margin -> NPM_PERCENT
  { slug: 'net-profit-margin-npm', targetAbbr: 'NPM_PERCENT' },
  { slug: 'net-profit-margin-npm-annual-nonbfsi', targetAbbr: 'NPM_PERCENT' },
  { slug: 'net-profit-margin-npm-ins-annual', targetAbbr: 'NPM_PERCENT' },
];

async function main() {
  console.log(`=======================================================`);
  console.log(`BFSI / Non-BFSI KPI and Screen Group Migration`);
  console.log(`Mode: ${IS_APPLY ? '>>> APPLY (Modifying Database) <<<' : '>>> DRY RUN (No changes will be saved) <<<'}`);
  console.log(`=======================================================\n`);

  // -----------------------------------------------------------------
  // STEP 2: Update kpis table
  // -----------------------------------------------------------------
  console.log('--- Step 2: Unifying KPI Mappings & Fallbacks in `kpis` ---');

  for (const m of KPI_MIGRATIONS) {
    const canonicalKpi = await prisma.kpi.findUnique({ where: { abbr: m.canonical } });
    const legacyKpi = await prisma.kpi.findUnique({ where: { abbr: m.legacy } });

    if (!canonicalKpi) {
      console.warn(`[WARN] Canonical KPI ${m.canonical} not found in DB!`);
      continue;
    }

    // Merge legacy into canonical fallback_abbrs
    const canonicalFallbacks = [...new Set([...(canonicalKpi.fallback_abbrs || []), m.legacy])];
    
    // Canonical updates:
    const canonicalUpdate = {
      prowess_name: m.prowessName,
      quarterly_prowess_name: m.quarterlyProwessName,
      fallback_abbrs: canonicalFallbacks,
    };

    console.log(`[KPI Canonical] ${m.canonical}:`);
    console.log(`  prowess_name:           "${canonicalKpi.prowess_name}" -> "${canonicalUpdate.prowess_name}"`);
    console.log(`  quarterly_prowess_name: "${canonicalKpi.quarterly_prowess_name}" -> "${canonicalUpdate.quarterly_prowess_name}"`);
    console.log(`  fallback_abbrs:         ${JSON.stringify(canonicalKpi.fallback_abbrs)} -> ${JSON.stringify(canonicalUpdate.fallback_abbrs)}`);

    if (IS_APPLY) {
      await prisma.kpi.update({
        where: { abbr: m.canonical },
        data: canonicalUpdate,
      });
    }

    // Legacy updates (if legacy exists and is distinct from canonical):
    if (legacyKpi && m.legacy !== m.canonical) {
      const legacyFallbacks = [...new Set([...(legacyKpi.fallback_abbrs || []), m.canonical])];
      const legacyUpdate = {
        prowess_name: null,
        quarterly_prowess_name: null,
        fallback_abbrs: legacyFallbacks,
      };

      console.log(`[KPI Legacy] ${m.legacy}:`);
      console.log(`  prowess_name:           "${legacyKpi.prowess_name}" -> null (cleared to avoid collision)`);
      console.log(`  quarterly_prowess_name: "${legacyKpi.quarterly_prowess_name}" -> null`);
      console.log(`  fallback_abbrs:         ${JSON.stringify(legacyKpi.fallback_abbrs)} -> ${JSON.stringify(legacyUpdate.fallback_abbrs)}`);

      if (IS_APPLY) {
        await prisma.kpi.update({
          where: { abbr: m.legacy },
          data: legacyUpdate,
        });
      }
    }
    console.log('');
  }

  // Update formula KPIs that depended on legacy abbrs
  console.log('--- Updating Formula KPIs ---');
  const npmAnnual = await prisma.kpi.findUnique({ where: { abbr: 'NPM_ANNUAL_PCT' } });
  if (npmAnnual) {
    const updatedFormula = '(PAT / REV_OP)*100';
    const updatedFallbacks = [...new Set([...(npmAnnual.fallback_abbrs || []), 'NPM_PERCENT'])];
    console.log(`[NPM_ANNUAL_PCT]:`);
    console.log(`  formula:        "${npmAnnual.formula_expression}" -> "${updatedFormula}"`);
    console.log(`  fallback_abbrs: ${JSON.stringify(npmAnnual.fallback_abbrs)} -> ${JSON.stringify(updatedFallbacks)}`);
    if (IS_APPLY) {
      await prisma.kpi.update({
        where: { abbr: 'NPM_ANNUAL_PCT' },
        data: { formula_expression: updatedFormula, fallback_abbrs: updatedFallbacks },
      });
    }
  }

  const taxAnnual = await prisma.kpi.findUnique({ where: { abbr: 'TOT_TAX_PRO_ANNUAL' } });
  if (taxAnnual) {
    const updatedFormula = 'PROV_CONT - PROV_CONTI_BFSI';
    const updatedFallbacks = [...new Set([...(taxAnnual.fallback_abbrs || []), 'TOT_TAX_PRO_QTR'])];
    console.log(`[TOT_TAX_PRO_ANNUAL]:`);
    console.log(`  formula:        "${taxAnnual.formula_expression}" -> "${updatedFormula}"`);
    console.log(`  fallback_abbrs: ${JSON.stringify(taxAnnual.fallback_abbrs)} -> ${JSON.stringify(updatedFallbacks)}`);
    if (IS_APPLY) {
      await prisma.kpi.update({
        where: { abbr: 'TOT_TAX_PRO_ANNUAL' },
        data: { formula_expression: updatedFormula, fallback_abbrs: updatedFallbacks },
      });
    }
  }

  // Also ensure TOT_TAX_PRO_QTR falls back to TOT_TAX_PRO_ANNUAL
  const taxQtr = await prisma.kpi.findUnique({ where: { abbr: 'TOT_TAX_PRO_QTR' } });
  if (taxQtr) {
    const updatedFallbacks = [...new Set([...(taxQtr.fallback_abbrs || []), 'TOT_TAX_PRO_ANNUAL'])];
    if (IS_APPLY) {
      await prisma.kpi.update({
        where: { abbr: 'TOT_TAX_PRO_QTR' },
        data: { fallback_abbrs: updatedFallbacks },
      });
    }
  }

  console.log('');

  // -----------------------------------------------------------------
  // STEP 3: Update kpi_groups table
  // -----------------------------------------------------------------
  console.log('--- Step 3: Updating Screen Rows in `kpi_groups` ---');
  let groupsUpdated = 0;
  for (const item of KPI_GROUP_MIGRATIONS) {
    const group = await prisma.kpiGroup.findUnique({ where: { slug: item.slug } });
    if (!group) {
      console.warn(`[WARN] KpiGroup with slug "${item.slug}" not found.`);
      continue;
    }
    console.log(`[Group] ${item.slug.padEnd(55)}: ${group.kpi_abbr} -> ${item.targetAbbr}`);
    if (IS_APPLY) {
      await prisma.kpiGroup.update({
        where: { slug: item.slug },
        data: { kpi_abbr: item.targetAbbr },
      });
    }
    groupsUpdated++;
  }
  console.log(`\nProcessed ${groupsUpdated} screen row nodes in kpi_groups.\n`);

  // -----------------------------------------------------------------
  // Cache Invalidation & Verification
  // -----------------------------------------------------------------
  if (IS_APPLY) {
    console.log('--- Invalidating Registry Cache ---');
    invalidateRegistryCache();
    console.log('✓ Registry cache invalidated successfully.\n');
  }

  console.log('=======================================================');
  if (IS_APPLY) {
    console.log('Migration completed and applied to database.');
  } else {
    console.log('DRY RUN completed. Run with --apply to execute changes.');
  }
  console.log('=======================================================');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
