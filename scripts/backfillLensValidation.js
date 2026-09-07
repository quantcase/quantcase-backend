#!/usr/bin/env node
'use strict';

/**
 * Backfill JSON Completeness Validation on existing html_incremental_skill_outputs
 *
 * Runs validateLensJsonCompleteness across existing outputs and updates
 * is_complete, missing_keys, completeness_score directly in the database.
 *
 * Usage:
 *   node scripts/backfillLensValidation.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { validateLensJsonCompleteness, SLUG_TO_NAME } = require('../services/lensValidation.service');

async function main() {
  console.log('Starting backfill of lens JSON completeness validation...\n');

  const skills = await prisma.htmlIncrementalSkill.findMany({
    select: { id: true, slug: true, name: true },
  });
  const skillIdToSlug = Object.fromEntries(skills.map(s => [s.id, s.slug]));

  const totalCount = await prisma.htmlIncrementalSkillOutput.count();
  console.log(`Total output records to validate: ${totalCount}`);

  let processed = 0;
  let completeCount = 0;
  let incompleteCount = 0;
  let skipped = 0;

  const BATCH_SIZE = 100;
  const CONCURRENCY = 25;
  let cursor = null;

  function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  while (true) {
    const outputs = await prisma.htmlIncrementalSkillOutput.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        skill_id: true,
        ticker: true,
        extracted_json: true,
      },
    });

    if (!outputs.length) break;
    cursor = outputs[outputs.length - 1].id;

    // Process validations in memory
    const updateTasks = [];
    for (const out of outputs) {
      const slug = skillIdToSlug[out.skill_id];
      if (!slug) {
        skipped++;
        continue;
      }

      const validation = validateLensJsonCompleteness(slug, out.extracted_json);
      if (validation.is_complete) {
        completeCount++;
      } else {
        incompleteCount++;
      }
      processed++;

      updateTasks.push({
        id: out.id,
        is_complete: validation.is_complete,
        missing_keys: validation.missing_keys,
        completeness_score: validation.completeness_score,
      });
    }

    // Execute updates concurrently in chunks
    const taskChunks = chunkArray(updateTasks, CONCURRENCY);
    for (const chunk of taskChunks) {
      await Promise.all(
        chunk.map(task =>
          prisma.htmlIncrementalSkillOutput.update({
            where: { id: task.id },
            data: {
              is_complete: task.is_complete,
              missing_keys: task.missing_keys,
              completeness_score: task.completeness_score,
            },
          })
        )
      );
    }

    const pct = ((processed / totalCount) * 100).toFixed(1);
    process.stdout.write(`\r[${pct}%] Processed ${processed}/${totalCount} outputs... (Complete: ${completeCount}, Incomplete: ${incompleteCount})`);
  }

  console.log('\n\n--- Backfill Summary ---');
  console.log(`Processed:  ${processed}`);
  console.log(`Complete:   ${completeCount} (${((completeCount / processed) * 100).toFixed(1)}%)`);
  console.log(`Incomplete: ${incompleteCount} (${((incompleteCount / processed) * 100).toFixed(1)}%)`);
  console.log(`Skipped:    ${skipped}`);
  console.log('Done!\n');
}

main()
  .catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
