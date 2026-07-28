'use strict';

/**
 * Seeds distinct Kpi rows for the columns in the new "day-block" annual
 * bulk-historical template (e.g. osc_sheet_192.csv/Consolidated,
 * osc_sheet_193.csv/Standalone) that ProwessUploader's annual parser
 * deliberately does NOT alias onto any existing abbr.
 *
 * Two groups, for two different reasons:
 *
 *   1. The "Non BFSI ..." columns (plus "Income from non-financial
 *      operations", which is the same family under a differently-worded
 *      name) look similar to existing generic P&L abbrs (TOTAL_COGS,
 *      TOTAL_OPEX, FIN_COST, PBT, REV_OP, DEP_AMORT, ...) but are NOT
 *      guaranteed to be the same figure -- the "Non BFSI" qualifier implies
 *      CMIE is giving a segment-scoped breakdown (excluding a company's
 *      BFSI/financial-services segment), which happens to equal the
 *      whole-company figure for a pure non-BFSI company but would silently
 *      diverge for any company with a mixed BFSI/non-BFSI business. Aliasing
 *      these onto the existing abbrs in the parser would have baked that
 *      assumption in with no way to tell the two apart later. Seeded here as
 *      their own abbrs instead -- admin can relate them to the generic
 *      abbrs via Kpi.fallback_abbrs (or a formula) once it's actually
 *      verified whether/when the two coincide, rather than the parser
 *      deciding silently.
 *
 *   2. "Non BFSI EBIT"/"Non BFSI EBITDA" specifically would have also
 *      collided with the EXISTING formula-derived EBIT/EBITDA Kpis
 *      (formula_expression: 'PBT + FIN_COST' / 'PBT + FIN_COST + DEP_AMORT')
 *      -- an abbr with formula_expression set is always evaluated via the
 *      formula, so a raw value ingested under that same abbr would just sit
 *      unread. Separate abbrs sidestep that entirely.
 *
 *   3. The consolidated-statement-specific lines (reported-vs-normalised
 *      PAT, associate/JV profit share, minority interest) are genuinely new
 *      concepts with no existing Kpi at all.
 *
 * Idempotent -- skips any abbr that already exists. Usage:
 *   node scripts/seedNonBfsiAnnualKpis.js
 */

const prisma = require('../config/prisma');
const kpis = require('../services/admin.kpis.service');
const { invalidateRegistryCache } = require('../utils/formulaRegistry/registryCache');

const NEW_KPIS = [
  // "Non BFSI" segment-scoped P&L family (order follows osc_sheet_192/193.csv's column order)
  { abbr: 'NONBFSI_REV_OP',    full_form: 'Revenue from Non-BFSI Operations',        prowess_name: 'Income from non-financial operations' },
  { abbr: 'NONBFSI_OTH_INC',   full_form: 'Other Income (Non-BFSI)',                 prowess_name: 'Non BFSI Other Income' },
  { abbr: 'NONBFSI_COGS',      full_form: 'Cost of Goods Sold (Non-BFSI)',           prowess_name: 'Non BFSI Cogs' },
  { abbr: 'NONBFSI_GM',        full_form: 'Gross Margin (Non-BFSI)',                 prowess_name: 'Non BFSI GM' },
  { abbr: 'NONBFSI_OPEX',      full_form: 'Operating Expenses (Non-BFSI)',           prowess_name: 'Non BFSI OPEX' },
  { abbr: 'NONBFSI_EBITDA',    full_form: 'EBITDA (Non-BFSI)',                       prowess_name: 'Non BFSI EBITDA' },
  { abbr: 'NONBFSI_DA',        full_form: 'Depreciation & Amortisation (Non-BFSI)',  prowess_name: 'Non BFSI DA' },
  { abbr: 'NONBFSI_OTHER_EXP', full_form: 'Other Expenses (Non-BFSI)',               prowess_name: 'Non BFSI Other Exp' },
  { abbr: 'NONBFSI_EBIT',      full_form: 'EBIT (Non-BFSI)',                         prowess_name: 'Non BFSI EBIT' },
  { abbr: 'NONBFSI_INT_EXP',   full_form: 'Interest Expense (Non-BFSI)',             prowess_name: 'Non BFSI Int Exp' },
  { abbr: 'NONBFSI_PBT',       full_form: 'Profit Before Tax (Non-BFSI)',            prowess_name: 'Non BFSI PBT' },
  // Consolidated-statement-specific lines -- genuinely new concepts, no segment-scope caveat
  { abbr: 'PAT_REPORTED',        full_form: 'Profit After Tax (As Reported by Company)',    prowess_name: 'Profit after tax as reported by company' },
  { abbr: 'PAT_NORM_DIFF',       full_form: 'Normalised vs Reported PAT Difference',        prowess_name: 'Difference between normalised pat and pat reported by company' },
  { abbr: 'ASSOCIATE_JV_SHARE',  full_form: 'Share in Profit/Loss of Associates/JV',        prowess_name: 'Share in profit/loss in associate/JV' },
  { abbr: 'PAT_POST_ASSOCIATE',  full_form: 'Net Profit After Share of Associates/JV',      prowess_name: 'Net profit/(loss) after share of profit/loss from associates/JV' },
  { abbr: 'MINORITY_INTEREST',   full_form: 'Profit/(Loss) Attributable to Minority Interest', prowess_name: 'Profit / (loss) attributable to: Minority interest' },
  { abbr: 'PAT_POST_MINORITY',   full_form: 'Net Profit After Minority Interest',           prowess_name: 'Profit / (loss) After share of Minority interest' },
];

const NONBFSI_DESCRIPTION =
  'CMIE\'s segment-scoped ("Non BFSI") breakdown from the day-block annual bulk-historical ' +
  'export -- equals the whole-company figure for a pure non-BFSI company, but may diverge from ' +
  'the generic whole-company abbr for a company with a mixed BFSI/non-BFSI business. Not ' +
  'auto-aliased to the generic abbr; relate the two via fallback_abbrs (or a formula) once ' +
  'verified, not assumed.';

async function main() {
  let created = 0, skipped = 0;
  for (const kpi of NEW_KPIS) {
    const existing = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
    if (existing) { console.log(`  exists: ${kpi.abbr}`); skipped++; continue; }
    await kpis.createKpi({
      abbr: kpi.abbr,
      full_form: kpi.full_form,
      denomination: 'rupee',
      prowess_name: kpi.prowess_name,
      unit_label: 'Cr',
      description: kpi.abbr.startsWith('NONBFSI_') ? NONBFSI_DESCRIPTION : null,
    });
    console.log(`  created: ${kpi.abbr}  (prowess_name: "${kpi.prowess_name}")`);
    created++;
  }
  console.log(`\nDone. ${created} created, ${skipped} already existed.`);
  invalidateRegistryCache();
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
