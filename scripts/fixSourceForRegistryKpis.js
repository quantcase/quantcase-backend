'use strict';

/**
 * One-time data fix: 26 registry-enabled Kpis were left with source:'transcript'
 * from the pre-formulaRegistry abbr-collision pattern (ROCE, EBITDA, ROE, ...),
 * which made GET /admin/kpis's default search (where: {source:'QE'}) unable to
 * find them -- admin couldn't map a CSV column (e.g. "Return on capital
 * employed") to ROCE because ROCE never showed up in the search. Flips their
 * source to 'QE' so they're visible in the default admin KPI search/mapping
 * flow.
 *
 * Deliberately does NOT touch full_form/kpi_type/industry -- only `source`.
 * Usage: node scripts/fixSourceForRegistryKpis.js
 */

const prisma = require('../config/prisma');

const ABBRS = [
  'PROFIT_MARGIN', 'NET_DEBT', 'GROSS_PROFIT', 'EBIT_MARGIN', 'EPS_BASIC',
  'DIVIDEND_YIELD', 'CASH_CONVERSION', 'EV_EBITDA', 'ENTERPRISE_VALUE',
  'EPS_CAGR', 'GROSS_SALES', 'ROCE', 'CAPEX', 'GROSS_MARGIN', 'PRICE',
  'QUICK_RATIO', 'PAT_CAGR', 'FCF', 'ROA', 'REV_CAGR', 'EBITDA',
  'EBITDA_MARGIN', 'EBIT', 'ROE', 'NET_DEBT_EBITDA', 'CURRENT_RATIO',
];

async function main() {
  const before = await prisma.kpi.findMany({
    where: { abbr: { in: ABBRS } },
    select: { abbr: true, source: true },
  });
  const alreadyQE = before.filter(k => k.source === 'QE').map(k => k.abbr);
  const toFix = before.filter(k => k.source !== 'QE');
  if (alreadyQE.length) console.log('Already source:QE (skipping):', alreadyQE.join(', '));
  if (before.length !== ABBRS.length) {
    console.log('WARNING -- missing abbrs:', ABBRS.filter(a => !before.some(k => k.abbr === a)).join(', '));
  }

  const result = await prisma.kpi.updateMany({
    where:  { abbr: { in: toFix.map(k => k.abbr) } },
    data:   { source: 'QE' },
  });
  console.log(`Updated ${result.count} rows: ${toFix.map(k => k.abbr).join(', ')}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
