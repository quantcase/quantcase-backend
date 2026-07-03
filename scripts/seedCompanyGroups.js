'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');
const { slugify } = require('../utils/slugify');

// A-Z split into 9 alphabetical buckets, dynamic (nameRange) so new tickers
// always land in the right bucket without re-seeding.
const ALPHA_RANGES = [
  ['A', 'C'], ['D', 'F'], ['G', 'I'], ['J', 'L'], ['M', 'O'],
  ['P', 'R'], ['S', 'U'], ['V', 'X'], ['Y', 'Z'],
];

const GROUPS = [
  ...ALPHA_RANGES.map(([from, to]) => ({
    name:          `Companies ${from}-${to}`,
    description:   `All companies with a ticker starting ${from}–${to}, re-evaluated live.`,
    filter_type:   'dynamic',
    filter_config: { nameRange: { from, to } },
  })),
  {
    name:          'FY2026 Q4 — Transcript Extracted',
    description:   'Companies with a non-invalidated transcript signal for FY2026 Q4.',
    filter_type:   'dynamic',
    filter_config: { extracted: { transcript: true, match: 'any', fiscalYear: 'FY2026', quarter: 'Q4' } },
  },
  {
    name:          'FY2026 Q4 — PPT Extracted',
    description:   'Companies with a non-invalidated PPT signal for FY2026 Q4.',
    filter_type:   'dynamic',
    filter_config: { extracted: { ppt: true, match: 'any', fiscalYear: 'FY2026', quarter: 'Q4' } },
  },
  {
    name:          'FY2026 Q4 — Transcript + PPT Extracted',
    description:   'Companies with BOTH a non-invalidated transcript signal and a non-invalidated PPT signal for FY2026 Q4.',
    filter_type:   'dynamic',
    filter_config: { extracted: { transcript: true, ppt: true, match: 'all', fiscalYear: 'FY2026', quarter: 'Q4' } },
  },
  {
    name:          'Annual Report FY2025-26 Extracted',
    description:   'Companies with a non-invalidated annual report signal for the latest AR cycle (FY2024-25 or FY2025-26).',
    filter_type:   'dynamic',
    filter_config: { extracted: { annualReport: true, fiscalYear: ['FY2024-25', 'FY2025-26'] } },
  },
];

async function main() {
  console.log(`Seeding ${GROUPS.length} company groups...\n`);

  for (const g of GROUPS) {
    const slug = slugify(g.name);
    const existing = await prisma.companyGroup.findUnique({ where: { slug } });
    if (existing) {
      console.log(`  SKIP   ${slug} (already exists)`);
      continue;
    }
    await prisma.companyGroup.create({ data: { slug, ...g } });
    console.log(`  CREATE ${slug}`);
  }

  console.log('\nDone.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
