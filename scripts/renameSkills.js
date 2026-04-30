'use strict';

/**
 * One-time script to rename skills to human-readable names.
 * Updates by slug (stable) so it's safe to re-run.
 *   node scripts/renameSkills.js
 */

const prisma = require('../config/prisma');

const SKILL_NAMES = [
  { slug: 'summarization',               name: 'Transcript PPT Summarization' },
  { slug: 'deal-analysis',               name: 'Deal Analysis' },
  { slug: 'ofactor-industry',            name: 'Opportunity Factor Industry' },
  { slug: 'ofactor-competition',         name: 'Opportunity Factor Competition' },
  { slug: 'ofactor-financial-strength',  name: 'Opportunity Factor Financial Strength' },
  { slug: 'ofactor-customer-traction',   name: 'Opportunity Factor Customer Traction' },
  { slug: 'ofactor-final-takeaways',     name: 'Opportunity Factor Final Takeaways' },
  { slug: 'qe-extraction',               name: 'Quarterly Extraction' },
  { slug: 'wealthos-suggestion',         name: 'WealthOS Suggestion' },
  { slug: 'wealthos-message',            name: 'WealthOS Message' },
];

async function main() {
  for (const { slug, name } of SKILL_NAMES) {
    const skill = await prisma.skill.findUnique({ where: { slug } });
    if (!skill) {
      console.warn(`  SKIP — no skill found with slug "${slug}"`);
      continue;
    }
    await prisma.skill.update({ where: { slug }, data: { name } });
    console.log(`  "${skill.name}" → "${name}"`);
  }
  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
