'use strict';

/**
 * scripts/fix_kpi_metadata.js
 *
 * 1. Sets prowess_name on BFSI_LOAN_ADV to 'BFSI Loan & Advances'
 * 2. Establishes mutual fallback_abbrs for EPS indicators
 * 3. Fixes typo in nonbfsi EPS child node
 * 4. Binds parent EPS nodes in kpi_groups to canonical EPS metrics
 */

const prisma = require('../config/prisma');

async function main() {
  console.log('=== Updating KPI Metadata & Screen Bindings ===\n');

  // 1. Update BFSI_LOAN_ADV
  const loanAdv = await prisma.kpi.updateMany({
    where: { abbr: 'BFSI_LOAN_ADV' },
    data: {
      prowess_name: 'BFSI Loan & Advances',
      quarterly_prowess_name: 'BFSI Loan & Advances',
      fallback_abbrs: ['ADVANCE_BFSI'],
    }
  });
  console.log(`✓ Updated BFSI_LOAN_ADV (${loanAdv.count} rows)`);

  // Update ADVANCE_BFSI fallbacks
  await prisma.kpi.updateMany({
    where: { abbr: 'ADVANCE_BFSI' },
    data: {
      fallback_abbrs: ['BFSI_LOAN_ADV'],
    }
  });
  console.log('✓ Updated ADVANCE_BFSI fallbacks');

  // 2. Mutual fallback_abbrs for EPS
  await prisma.kpi.updateMany({
    where: { abbr: 'EPS_BASIC' },
    data: {
      fallback_abbrs: ['EPS_AFTER_EXTRA', 'EPS_BFR_EXTRA', 'EPS_DILUTED'],
    }
  });
  await prisma.kpi.updateMany({
    where: { abbr: 'EPS_AFTER_EXTRA' },
    data: {
      fallback_abbrs: ['EPS_BASIC', 'EPS_BFR_EXTRA', 'DIL_EPS_AFTR_EXTRA'],
    }
  });
  await prisma.kpi.updateMany({
    where: { abbr: 'EPS_BFR_EXTRA' },
    data: {
      fallback_abbrs: ['EPS_BASIC', 'EPS_AFTER_EXTRA'],
    }
  });
  await prisma.kpi.updateMany({
    where: { abbr: 'DIL_EPS_AFTR_EXTRA' },
    data: {
      fallback_abbrs: ['EPS_DILUTED', 'DIL_EPS_BFR_EXTRA'],
    }
  });
  await prisma.kpi.updateMany({
    where: { abbr: 'EPS_DILUTED' },
    data: {
      fallback_abbrs: ['DIL_EPS_AFTR_EXTRA', 'DIL_EPS_BFR_EXTRA'],
    }
  });
  console.log('✓ Updated EPS mutual fallback_abbrs');

  // 3. Fix typo in nonbfsi EPS child node
  const fixTypo = await prisma.kpiGroup.updateMany({
    where: { slug: 'earnings-per-share-before-extraordinary-item-annual-nonbfsi' },
    data: { kpi_abbr: 'EPS_BFR_EXTRA' }
  });
  console.log(`✓ Fixed nonbfsi EPS child node typo (${fixTypo.count} rows)`);

  // 4. Bind parent EPS nodes in kpi_groups
  const parentBindings = [
    { slug: 'eps-annual-bfsi', kpi_abbr: 'EPS_AFTER_EXTRA' },
    { slug: 'eps-annual-nonbfsi', kpi_abbr: 'EPS_AFTER_EXTRA' },
    { slug: 'eps-annual-ins', kpi_abbr: 'EPS_AFTER_EXTRA' },
    { slug: 'eps-qtr-bfsi', kpi_abbr: 'EPS_BASIC' },
    { slug: 'eps-qtr-nonbfsi', kpi_abbr: 'EPS_BASIC' },
    { slug: 'eps-qtr-ins', kpi_abbr: 'EPS_BASIC' },
  ];

  for (const b of parentBindings) {
    const res = await prisma.kpiGroup.updateMany({
      where: { slug: b.slug },
      data: { kpi_abbr: b.kpi_abbr }
    });
    console.log(`✓ Bound parent group ${b.slug} → ${b.kpi_abbr} (${res.count} rows)`);
  }

  console.log('\n=== All metadata updates applied successfully ===');
}

main()
  .catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
