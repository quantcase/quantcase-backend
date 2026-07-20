'use strict';

/**
 * ONE-TIME MIGRATION. Bootstraps the KpiGroup display hierarchy for P&L /
 * Balance Sheet / Cash Flow from the (previously live) ScreenConfigItem rows,
 * then points each financials.* ScreenConfig at its new KpiGroup branch via
 * `kpi_group_slug` — lib/financials.js now builds these tables by walking
 * that KpiGroup tree directly, not ScreenConfigItem. Going forward, admin
 * manages the row list/hierarchy for these tables through /admin/kpi-groups
 * (create/reparent/reorder/delete nodes) instead of per-item CRUD on
 * ScreenConfigItem.
 *
 * DO NOT RE-RUN this after admin starts editing groups via /admin/kpi-groups
 * -- it still deletes+rebuilds the 3 statement roots from the ScreenConfigItem
 * snapshot below (now frozen/unused), so re-running would silently wipe any
 * manual edits made directly on the KpiGroup tree since. It's kept here as
 * the historical record of how the tree was originally built, and as a
 * reference pattern if a *new* statement/section ever needs the same
 * bootstrap treatment.
 *
 * The old ScreenConfigItem rows for these 6 keys are left in place,
 * deliberately not deleted -- nothing reads them anymore (harmless, dormant),
 * and leaving them is the reversible choice if anything about this migration
 * needs to be double-checked against the old shape.
 *
 * Context for why this tree existed before it drove the live tables: it was
 * migrated once from old KpiRelationship('statement_of') rows and never
 * touched again, so it drifted from the real screener (referenced abbrs no
 * longer shown, e.g. TOTAL_INCOME/CURR_LIAB/DEBT_LT, and was missing ones
 * that are shown, e.g. OP_PROFIT/OPM) -- this rebuild fixed that drift once,
 * from the then-live ScreenConfigItem rows.
 *
 * Structure (order/labels verified against screener.in's own P&L/Balance
 * Sheet/Cash Flow tables, e.g. https://www.screener.in/company/MSUMI/):
 *
 *   pnl-statement                    ("Profit & Loss")
 *     +- pnl-statement--annual       ("Annual")    -- leaves = financials.pnl.annual's items
 *     +- pnl-statement--quarterly    ("Quarterly") -- leaves = financials.pnl.quarterly's items
 *   balance-sheet-statement          ("Balance Sheet")
 *     +- ...--annual / ...--quarterly              -- leaves = financials.balance-sheet.{annual,quarterly}
 *   cashflow-statement               ("Cash Flow")
 *     +- ...--annual / ...--quarterly              -- leaves = financials.cashflow.{annual,quarterly}
 *
 * Leaf label = the ScreenConfigItem's own label (e.g. "Sales", "Reserves") --
 * the friendly name actually shown on screen -- not Kpi.full_form (e.g.
 * "Revenue from Operations"), so this tree can double as a label->abbr
 * lookup for admin.
 *
 * The old kpi_type-based roots (kpi-type-*) are deleted outright: kpi_type
 * has no remaining consumer now that KpiGroup owns display grouping (only
 * this script and the admin CRUD schema still reference the field), so
 * leaving those roots in place would just be more dead filter options.
 *
 * Not idempotent by upsert -- deletes and fully rebuilds the 3 statement
 * roots (and, once, the kpi-type-* roots) every run. Cheap (~60 rows) and
 * avoids reconciling old flat slugs against the new nested annual/quarterly
 * ones.
 *
 * A 4th level exists for the handful of statement rows that have a real,
 * data-backed breakdown available -- today just Fixed Assets (component
 * assets from the original Prowess ingestion, e.g. Land/Building/Plant &
 * Machinery, each verified against prowess_values_new to have real coverage
 * across 1,000+ companies before being flipped registry_enabled) and
 * Borrowings (Long/Short-Term, both already registry_enabled). Declared in
 * SUB_ITEMS below, keyed by the parent leaf's kpi_abbr. P&L/Cash Flow have no
 * entries here by design -- their sub-item data (e.g. Employee Cost, Power &
 * Fuel) is either missing or too thin to enable yet; left for admin to wire
 * once ready, same mechanism (just add an entry to SUB_ITEMS).
 *
 * Usage: node scripts/seedKpiGroups.js
 */

const prisma = require('../config/prisma');
const { slugify } = require('../utils/slugify');

const STATEMENTS = [
  { rootSlug: 'pnl-statement', rootLabel: 'Profit & Loss', annualKey: 'financials.pnl.annual', quarterlyKey: 'financials.pnl.quarterly' },
  { rootSlug: 'balance-sheet-statement', rootLabel: 'Balance Sheet', annualKey: 'financials.balance-sheet.annual', quarterlyKey: 'financials.balance-sheet.quarterly' },
  { rootSlug: 'cashflow-statement', rootLabel: 'Cash Flow', annualKey: 'financials.cashflow.annual', quarterlyKey: 'financials.cashflow.quarterly' },
];

// parent leaf kpi_abbr -> ordered list of {abbr, label} children. Every abbr
// here must already be registry_enabled (checked at runtime, not assumed).
const SUB_ITEMS = {
  ASSET_PPE: [
    { abbr: 'ASSET_LAND_NET', label: 'Land' },
    { abbr: 'ASSET_BLDG_NET', label: 'Building' },
    { abbr: 'ASSET_PM_NET', label: 'Plant & Machinery' },
    { abbr: 'ASSET_ELEC_NET', label: 'Electrical Installations' },
    { abbr: 'ASSET_FURN_NET', label: 'Furniture & Fixtures' },
    { abbr: 'ASSET_IT_NET', label: 'Computers & IT Equipment' },
    { abbr: 'ASSET_TRANS_NET', label: 'Vehicles' },
    { abbr: 'ASSET_LEASE_IMP_NET', label: 'Leasehold Improvements' },
    { abbr: 'ASSET_MINING_NET', label: 'Mining / Oil & Gas Properties' },
    { abbr: 'ASSET_BIO_NET', label: 'Biological Assets (Bearer Plants)' },
  ],
  BORR_TOTAL: [
    { abbr: 'DEBT_LT', label: 'Long-Term Borrowings' },
    { abbr: 'DEBT_ST', label: 'Short-Term Borrowings' },
  ],
};

const STALE_KPI_TYPE_ROOTS = [
  'kpi-type-assets', 'kpi-type-liabilities', 'kpi-type-equity', 'kpi-type-revenue',
  'kpi-type-cogs', 'kpi-type-operating-expenses', 'kpi-type-profit-lines',
  'kpi-type-cashflow', 'kpi-type-customer-kpis', 'kpi-type-industry-specific',
];

async function deleteStaleGroups() {
  console.log('== Deleting stale groups (kpi-type-* roots, old statement roots) ==');
  const staleRootSlugs = [...STALE_KPI_TYPE_ROOTS, ...STATEMENTS.map((s) => s.rootSlug)];
  const { count } = await prisma.kpiGroup.deleteMany({ where: { slug: { in: staleRootSlugs } } });
  console.log(`  deleted ${count} root(s) (cascades to their descendants)`);
}

async function buildFrequencyBranch(parentId, label, configKey, slugPrefix, order) {
  const branchSlug = `${slugPrefix}--${slugify(label)}`;
  const branch = await prisma.kpiGroup.create({
    data: { slug: branchSlug, label, parent_id: parentId, kpi_abbr: null, display_order: order },
  });
  console.log(`  + ${label} (${branchSlug})`);

  const config = await prisma.screenConfig.findUnique({ where: { key: configKey }, include: { items: true } });
  if (!config) {
    console.log(`    !! no ScreenConfig found for key "${configKey}" -- branch left empty`);
    return;
  }

  const items = [...config.items].sort((a, b) => a.display_order - b.display_order);
  for (const item of items) {
    const leaf = await prisma.kpiGroup.create({
      data: {
        slug: `${branchSlug}--${slugify(item.kpi_abbr)}`,
        label: item.label ?? item.kpi_abbr,
        parent_id: branch.id,
        kpi_abbr: item.kpi_abbr,
        display_order: item.display_order,
      },
    });
    console.log(`    - ${item.kpi_abbr} (${item.label})`);
    await buildSubItems(leaf, branchSlug);
  }
}

async function buildSubItems(parentLeaf, branchSlug) {
  const subItems = SUB_ITEMS[parentLeaf.kpi_abbr];
  if (!subItems) return;
  let order = 0;
  for (const sub of subItems) {
    const kpi = await prisma.kpi.findUnique({ where: { abbr: sub.abbr }, select: { registry_enabled: true } });
    if (!kpi?.registry_enabled) {
      console.log(`      !! skipping ${sub.abbr} -- not registry_enabled`);
      continue;
    }
    await prisma.kpiGroup.create({
      data: {
        slug: `${branchSlug}--${slugify(parentLeaf.kpi_abbr)}--${slugify(sub.abbr)}`,
        label: sub.label,
        parent_id: parentLeaf.id,
        kpi_abbr: sub.abbr,
        display_order: order++,
      },
    });
    console.log(`      * ${sub.abbr} (${sub.label})`);
  }
}

async function buildStatementTree(stmt, order) {
  console.log(`\n== ${stmt.rootLabel} ==`);
  const root = await prisma.kpiGroup.create({
    data: { slug: stmt.rootSlug, label: stmt.rootLabel, parent_id: null, kpi_abbr: null, display_order: order },
  });
  await buildFrequencyBranch(root.id, 'Annual', stmt.annualKey, stmt.rootSlug, 0);
  await buildFrequencyBranch(root.id, 'Quarterly', stmt.quarterlyKey, stmt.rootSlug, 1);

  const annualBranchSlug    = `${stmt.rootSlug}--annual`;
  const quarterlyBranchSlug = `${stmt.rootSlug}--quarterly`;
  await prisma.screenConfig.update({ where: { key: stmt.annualKey }, data: { kpi_group_slug: annualBranchSlug } });
  await prisma.screenConfig.update({ where: { key: stmt.quarterlyKey }, data: { kpi_group_slug: quarterlyBranchSlug } });
  console.log(`  wired ${stmt.annualKey} -> ${annualBranchSlug}, ${stmt.quarterlyKey} -> ${quarterlyBranchSlug}`);
}

async function main() {
  await deleteStaleGroups();
  let order = 0;
  for (const stmt of STATEMENTS) {
    await buildStatementTree(stmt, order++);
  }
  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
