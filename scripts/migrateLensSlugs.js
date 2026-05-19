#!/usr/bin/env node
'use strict';

/**
 * Migrate LensConfig slugs from the old 7-lens schema to the new 10-lens schema.
 *
 * Renames (preserving config/weights):
 *   governance-quality   → split: governance signals → disclosure-honesty
 *                                  promoter signals  → promoter-activity (new row)
 *   industry-position    → industry-analysis
 *   competitive-strength → competition
 *   financial-health     → financial-strength
 *   customer-traction    → customer-distribution
 *
 * Also updates LensScore rows that reference the old slugs.
 *
 * New additions (deal category):
 *   eps-engine
 *   pe-rerating-potential
 *
 * Run: node scripts/migrateLensSlugs.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');

const HAIKU = 'anthropic/claude-haiku-4.5';

// Simple renames: old slug → { newSlug, newName, newDescription }
const RENAMES = [
  {
    old:         'governance-quality',
    newSlug:     'disclosure-honesty',
    newName:     'Disclosure Honesty',
    newDesc:     'Transparency and candour of management disclosures — proactive vs defensive communication',
  },
  {
    old:         'industry-position',
    newSlug:     'industry-analysis',
    newName:     'Industry Analysis',
    newDesc:     'Demand/supply dynamics and structural positioning within the industry',
  },
  {
    old:         'competitive-strength',
    newSlug:     'competition',
    newName:     'Competition',
    newDesc:     'Market moat, pricing power, and competitive differentiation vs peers',
  },
  {
    old:         'financial-health',
    newSlug:     'financial-strength',
    newName:     'Financial Strength',
    newDesc:     'Balance sheet strength, FCF generation, and margin quality',
  },
  {
    old:         'customer-traction',
    newSlug:     'customer-distribution',
    newName:     'Customer & Distribution',
    newDesc:     'Client base growth, channel quality, and revenue concentration risk',
  },
];

// Brand-new lens rows to create
const NEW_CONFIGS = [
  {
    slug:        'promoter-activity',
    name:        'Promoter Activity',
    category:    'management',
    description: 'Promoter shareholding trends, pledging, and insider confidence signals',
    config: {
      signal_filters: {
        signal_types:  ['governance'],
        metric_family: ['governance'],
      },
      weights: [
        { metric: 'promoter_pledge',    w: -0.6 },
        { metric: 'promoter_buying',    w:  0.5 },
        { metric: 'promoter_selling',   w: -0.4 },
        { metric: 'insider_confidence', w:  0.3 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      800,
      prompt_template: null,
    },
  },
  {
    slug:        'eps-engine',
    name:        'EPS Engine',
    category:    'deal',
    description: 'Earnings per share trajectory, earnings growth levers, and consensus beat history',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'financial_health'],
        metric_family: ['profitability', 'growth'],
      },
      weights: [
        { metric: 'PAT',           w:  0.35, b: 0 },
        { metric: 'EBITDA',        w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN', w:  0.2,  b: 0 },
        { metric: 'REV_OP',        w:  0.15, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      800,
      prompt_template: null,
    },
  },
  {
    slug:        'pe-rerating-potential',
    name:        'P/E Re-Rating Potential',
    category:    'deal',
    description: 'Likelihood of multiple expansion driven by improving fundamentals, guidance clarity, and sector tailwinds',
    config: {
      signal_filters: {
        signal_types:  ['milestone', 'governance', 'kpi'],
        metric_family: ['milestone', 'governance', 'growth'],
      },
      weights: [
        { metric: 'guidance_given',       w:  0.3 },
        { metric: 'guidance_missed',      w: -0.4 },
        { metric: 'proactive_disclosure', w:  0.2 },
        { metric: 'REV_OP',               w:  0.2, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      800,
      prompt_template: null,
    },
  },
];

async function main() {
  console.log('=== Lens slug migration ===\n');

  // ── Step 1: Rename existing LensConfig rows ──────────────────────────────────
  for (const { old: oldSlug, newSlug, newName, newDesc } of RENAMES) {
    const existing = await prisma.lensConfig.findUnique({ where: { slug: oldSlug } });
    if (!existing) {
      console.log(`  SKIP rename ${oldSlug} → ${newSlug} (not found)`);
      continue;
    }
    const conflict = await prisma.lensConfig.findUnique({ where: { slug: newSlug } });
    if (conflict) {
      console.log(`  SKIP rename ${oldSlug} → ${newSlug} (target slug already exists)`);
      continue;
    }

    // Rename LensConfig row (preserves config/weights)
    await prisma.lensConfig.update({
      where: { slug: oldSlug },
      data:  { slug: newSlug, name: newName, description: newDesc, updated_at: new Date() },
    });
    console.log(`  ✓ Renamed LensConfig: ${oldSlug} → ${newSlug}`);

    // Update all LensScore rows that reference the old slug
    const staleCount = await prisma.lensScore.updateMany({
      where: { lens_slug: oldSlug },
      data:  { lens_slug: newSlug, is_stale: true },
    });
    console.log(`    → Migrated + staled ${staleCount.count} LensScore rows`);
  }

  console.log('');

  // ── Step 2: Create new lens rows ──────────────────────────────────────────────
  for (const cfg of NEW_CONFIGS) {
    const existing = await prisma.lensConfig.findUnique({ where: { slug: cfg.slug } });
    if (existing) {
      console.log(`  SKIP create ${cfg.slug} (already exists)`);
      continue;
    }
    await prisma.lensConfig.create({ data: cfg });
    console.log(`  ✓ Created LensConfig: ${cfg.slug} (category: ${cfg.category})`);
  }

  // ── Step 3: Update seedLensConfigs.js to reflect new slugs ───────────────────
  console.log('\n=== Summary ===');
  const all = await prisma.lensConfig.findMany({ where: { is_active: true }, orderBy: { category: 'asc' } });
  for (const lc of all) {
    console.log(`  [${lc.category ?? 'none'}] ${lc.slug} — ${lc.name}`);
  }

  console.log('\nDone. Run /api/lenses/compute to recompute scores with the new slugs.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
