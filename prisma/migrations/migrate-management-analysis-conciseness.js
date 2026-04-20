'use strict';

/**
 * Migration: update management-analysis skill promptTemplate + outputSchema
 *
 * Changes:
 *  - red_flags: enforce ≤8/15/12 word limits on title/evidence/implication with emojis
 *  - next_concall_watchlist: tighten why_it_matters/green_signal/red_signal to ≤12/10/10 words
 *
 * Run:  node prisma/migrations/migrate-management-analysis-conciseness.js
 */

const prisma = require('../../config/prisma');
const { PROMPT_TEMPLATE, OUTPUT_SCHEMA } = require('../../prompts/management_analysis');

async function run() {
  const skill = await prisma.skill.findUnique({ where: { slug: 'management-analysis' } });
  if (!skill) {
    console.error('Skill "management-analysis" not found — ensure it has been seeded first.');
    process.exit(1);
  }

  await prisma.skill.update({
    where: { slug: 'management-analysis' },
    data: {
      promptTemplate: PROMPT_TEMPLATE,
      outputSchema:   OUTPUT_SCHEMA,
    },
  });

  console.log('✅ management-analysis skill updated with concise red_flags + watchlist rules.');
}

run()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
