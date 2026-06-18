'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SKILLS = [
  // management
  { slug: 'guidance-credibility',   name: 'Guidance Credibility',   category: 'management' },
  { slug: 'disclosure-honesty',     name: 'Disclosure Honesty',     category: 'management' },
  { slug: 'capital-allocation',     name: 'Capital Allocation',     category: 'management' },
  { slug: 'promoter-activity',      name: 'Promoter Activity',      category: 'management' },
  // opportunity
  { slug: 'industry-analysis',      name: 'Industry Analysis',      category: 'opportunity' },
  { slug: 'financial-strength',     name: 'Financial Strength',     category: 'opportunity' },
  { slug: 'customer-distribution',  name: 'Customer Distribution',  category: 'opportunity' },
  { slug: 'competition',            name: 'Competition',            category: 'opportunity' },
  // deal
  { slug: 'earning-quality',        name: 'Earning Quality',        category: 'deal' },
  { slug: 'earnings-forecast',      name: 'Earnings Forecast',      category: 'deal' },
  { slug: 'pe-rerating-potential',  name: 'PE Rerating Potential',  category: 'deal' },
  { slug: 'target-price-matrix',    name: 'Target Price Matrix',    category: 'deal' },
];

async function main() {
  for (const skill of SKILLS) {
    const result = await prisma.htmlSkill.upsert({
      where: { slug: skill.slug },
      update: {},
      create: {
        slug: skill.slug,
        name: skill.name,
        skill_prompt: '',
        signal_types: [],
        category: skill.category,
      },
    });
    console.log(`Upserted: ${result.slug} [${result.category}] (${result.id})`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
