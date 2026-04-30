'use strict';

/**
 * Backfill slugs for existing Skill and Plugin rows that have slug = NULL.
 * Run once after adding the nullable slug column:
 *   node scripts/backfillSlugs.js
 */

const prisma  = require('../config/prisma');
const { slugify } = require('../utils/slugify');

async function backfill() {
  // ── Skills ────────────────────────────────────────────────────────────────
  const skills = await prisma.skill.findMany({ where: { slug: null } });
  console.log(`Skills to backfill: ${skills.length}`);

  for (const skill of skills) {
    const slug = slugify(skill.name);
    await prisma.skill.update({ where: { id: skill.id }, data: { slug } });
    console.log(`  skill "${skill.name}" → "${slug}"`);
  }

  // ── Plugins ───────────────────────────────────────────────────────────────
  const plugins = await prisma.plugin.findMany({ where: { slug: null } });
  console.log(`Plugins to backfill: ${plugins.length}`);

  for (const plugin of plugins) {
    const slug = slugify(plugin.name);
    await prisma.plugin.update({ where: { id: plugin.id }, data: { slug } });
    console.log(`  plugin "${plugin.name}" → "${slug}"`);
  }

  console.log('Done.');
}

backfill()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
