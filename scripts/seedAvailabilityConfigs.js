#!/usr/bin/env node
'use strict';

/**
 * Seeds three named configs (t1/t2/t3) on every active HtmlIncrementalSkill,
 * one per data-availability scenario admins pick between at run time (see
 * configKey on POST /:slug/run):
 *
 *   t1 — Full: transcript + ppt + annual report all present
 *   t2 — No Transcript: only ppt + annual report present
 *   t3 — Annual Report Only: only annual report present
 *
 * All three are seeded as an exact clone of the skill's own current
 * top-level fields (prompt, filters, caps, model, max_tokens, strip_html) —
 * t1 stays as the real "everything available" case, t2/t3 are placeholders
 * to be hand-tuned later (e.g. clearing transcript_signal_types for t2,
 * clearing transcript+ppt for t3) via the config CRUD endpoints.
 *
 * Idempotent: skips a (skill, key) pair that already has a config, unless
 * --force is passed (overwrites in place).
 *
 * Usage: node scripts/seedAvailabilityConfigs.js [--force]
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { defaultConfigFieldsFromSkill: cloneFields } = require('../services/htmlIncrementalSkill.service');

const force = process.argv.includes('--force');

const VARIANTS = [
  { key: 't1', name: 'Full (T1) — transcript + ppt + annual report' },
  { key: 't2', name: 'No Transcript (T2) — ppt + annual report only' },
  { key: 't3', name: 'Annual Report Only (T3)' },
];

async function main() {
  const skills = await prisma.htmlIncrementalSkill.findMany({ where: { is_active: true } });
  console.log(`\n${skills.length} active skills. Mode: ${force ? 'force (overwrite existing)' : 'skip existing'}\n`);

  let seeded = 0, skipped = 0, failed = 0;

  for (const skill of skills) {
    const fields = cloneFields(skill);
    for (const variant of VARIANTS) {
      try {
        const existing = await prisma.htmlIncrementalSkillConfig.findUnique({
          where: { skill_id_key: { skill_id: skill.id, key: variant.key } },
        });

        if (existing && !force) {
          skipped++;
          continue;
        }

        if (existing) {
          await prisma.htmlIncrementalSkillConfig.update({
            where: { id: existing.id },
            data:  { name: variant.name, ...fields },
          });
        } else {
          await prisma.htmlIncrementalSkillConfig.create({
            data: { skill_id: skill.id, key: variant.key, name: variant.name, ...fields },
          });
        }

        console.log(`  SEED  ${skill.slug.padEnd(24)} ${variant.key}`);
        seeded++;
      } catch (err) {
        console.error(`  FAIL  ${skill.slug} ${variant.key}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone.`);
  console.log(`  Seeded:  ${seeded}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${failed}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
