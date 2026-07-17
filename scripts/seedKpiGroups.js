'use strict';

/**
 * One-off, idempotent seed for the new KpiGroup display hierarchy:
 *
 *  1. One root KpiGroup per distinct Kpi.kpi_type value among registry_enabled
 *     rows (the "mixture of kpi_type and parent-child grouping" the admin
 *     asked for) — a leaf child under each root for every Kpi with that type.
 *  2. Migrates the existing 'statement_of' KpiRelationship rows (PNL/Balance
 *     Sheet/Cashflow headers) into a parallel KpiGroup tree — same source
 *     data, now expressed as a real tree instead of a flat one-level
 *     relationship. The old KpiRelationship rows and PNL_STATEMENT/
 *     BALANCE_SHEET_STATEMENT/CASHFLOW_STATEMENT header Kpi rows are left in
 *     place (harmless, just no longer the canonical grouping mechanism) —
 *     not deleted here.
 *
 * A Kpi can legitimately appear as a leaf under both a kpi_type root and a
 * statement root — these are two independent, simultaneous views admin can
 * use for different table/chart sections, not a single taxonomy to merge.
 *
 * Usage:
 *   node scripts/seedKpiGroups.js            # dry run, prints planned inserts
 *   node scripts/seedKpiGroups.js --insert   # actually write
 */

const { PrismaClient } = require('@prisma/client');
const { slugify } = require('../utils/slugify');

const prisma = new PrismaClient();
const INSERT = process.argv.includes('--insert');

const KPI_TYPE_LABELS = {
  assets: 'Assets',
  liabilities: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  cogs: 'Cost of Goods Sold',
  operating_expenses: 'Operating Expenses',
  profit_lines: 'Profit Lines',
  cashflow: 'Cashflow',
  customer_kpis: 'Customer KPIs',
  industry_specific: 'Industry Specific',
};

const STATEMENT_HEADERS = [
  { abbr: 'PNL_STATEMENT', slug: 'pnl-statement', label: 'P&L Statement' },
  { abbr: 'BALANCE_SHEET_STATEMENT', slug: 'balance-sheet-statement', label: 'Balance Sheet' },
  { abbr: 'CASHFLOW_STATEMENT', slug: 'cashflow-statement', label: 'Cashflow Statement' },
];

async function upsertGroup(data) {
  console.log(`  ${INSERT ? 'upsert' : '[dry] would upsert'}: ${data.slug} (parent=${data.parent_id ?? 'root'}, kpi_abbr=${data.kpi_abbr ?? '-'})`);
  if (!INSERT) return { id: `dry:${data.slug}` };
  return prisma.kpiGroup.upsert({
    where: { slug: data.slug },
    update: { label: data.label, parent_id: data.parent_id ?? null, kpi_abbr: data.kpi_abbr ?? null, display_order: data.display_order ?? 0 },
    create: data,
  });
}

async function seedKpiTypeRoots() {
  console.log('\n== kpi_type roots ==');
  const kpis = await prisma.kpi.findMany({
    where: { registry_enabled: true, kpi_type: { not: null } },
    orderBy: [{ kpi_type: 'asc' }, { display_order: 'asc' }, { abbr: 'asc' }],
  });
  const byType = new Map();
  for (const k of kpis) {
    if (!byType.has(k.kpi_type)) byType.set(k.kpi_type, []);
    byType.get(k.kpi_type).push(k);
  }

  let rootOrder = 0;
  for (const [kpiType, members] of byType) {
    const rootSlug = `kpi-type-${slugify(kpiType)}`;
    const root = await upsertGroup({
      slug: rootSlug,
      label: KPI_TYPE_LABELS[kpiType] ?? kpiType,
      parent_id: null,
      kpi_abbr: null,
      display_order: rootOrder++,
    });
    let childOrder = 0;
    for (const kpi of members) {
      await upsertGroup({
        slug: `${rootSlug}--${slugify(kpi.abbr)}`,
        label: kpi.full_form,
        parent_id: root.id,
        kpi_abbr: kpi.abbr,
        display_order: childOrder++,
      });
    }
  }
}

async function seedStatementTree() {
  console.log('\n== statement tree (migrated from KpiRelationship statement_of) ==');
  const rels = await prisma.kpiRelationship.findMany({ where: { relationship_type: 'statement_of' } });
  const byHeader = new Map();
  for (const r of rels) {
    if (!byHeader.has(r.related_kpi_abbr)) byHeader.set(r.related_kpi_abbr, []);
    byHeader.get(r.related_kpi_abbr).push(r);
  }

  for (const header of STATEMENT_HEADERS) {
    const root = await upsertGroup({
      slug: header.slug,
      label: header.label,
      parent_id: null,
      kpi_abbr: null,
      display_order: 0,
    });
    const children = (byHeader.get(header.abbr) ?? []).sort((a, b) => a.display_order - b.display_order);
    let childOrder = 0;
    for (const rel of children) {
      const kpi = await prisma.kpi.findUnique({ where: { abbr: rel.kpi_abbr } });
      await upsertGroup({
        slug: `${header.slug}--${slugify(rel.kpi_abbr)}`,
        label: kpi?.full_form ?? rel.kpi_abbr,
        parent_id: root.id,
        kpi_abbr: rel.kpi_abbr,
        display_order: childOrder++,
      });
    }
  }
}

async function main() {
  console.log(`seedKpiGroups.js — mode: ${INSERT ? 'INSERT' : 'DRY RUN (pass --insert to write)'}`);
  await seedKpiTypeRoots();
  await seedStatementTree();
  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
