#!/usr/bin/env node
'use strict';

/**
 * Seed html_incremental_skill_outputs from existing html_skill_outputs.
 *
 * This lets the incremental flow use prior full-run analyses as its initial
 * base context without waiting for the first incremental run to complete.
 *
 * Usage:
 *   node scripts/seedIncrementalFromFullRun.js --source-slug competition --target-slug competition-incremental
 *   node scripts/seedIncrementalFromFullRun.js --source-slug competition --target-slug competition-incremental --force
 *
 * Options:
 *   --source-slug   slug of the HtmlSkill whose outputs to import (required)
 *   --target-slug   slug of the HtmlIncrementalSkill to seed into (required)
 *   --force         overwrite existing rows (default: skip)
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { stripHtmlToText } = require('../utils/stripHtml');

const args       = process.argv.slice(2);
const sourceSlug = args[args.indexOf('--source-slug') + 1];
const targetSlug = args[args.indexOf('--target-slug') + 1];
const force      = args.includes('--force');

if (!sourceSlug || !targetSlug) {
  console.error('Usage: node scripts/seedIncrementalFromFullRun.js --source-slug <slug> --target-slug <slug> [--force]');
  process.exit(1);
}

async function main() {
  const sourceSkill = await prisma.htmlSkill.findUnique({ where: { slug: sourceSlug } });
  if (!sourceSkill) {
    console.error(`Source HtmlSkill not found: "${sourceSlug}"`);
    process.exit(1);
  }

  const targetSkill = await prisma.htmlIncrementalSkill.findUnique({ where: { slug: targetSlug } });
  if (!targetSkill) {
    console.error(`Target HtmlIncrementalSkill not found: "${targetSlug}"`);
    process.exit(1);
  }

  const outputs = await prisma.htmlSkillOutput.findMany({
    where: { skill_id: sourceSkill.id },
  });

  console.log(`\nSource: "${sourceSlug}" → ${outputs.length} outputs`);
  console.log(`Target: "${targetSlug}" (id: ${targetSkill.id})`);
  console.log(`Mode:   ${force ? 'force (overwrite existing)' : 'skip existing'}\n`);

  let seeded = 0, skipped = 0, failed = 0;

  for (const row of outputs) {
    try {
      const existing = await prisma.htmlIncrementalSkillOutput.findFirst({
        where: {
          skill_id:    targetSkill.id,
          ticker:      row.ticker,
          fiscal_year: row.fiscal_year ?? null,
          quarter:     row.quarter     ?? null,
        },
      });

      if (existing && !force) {
        skipped++;
        continue;
      }

      const text_summary = stripHtmlToText(row.raw_html);
      const prompt_v     = `seeded-from:${sourceSlug}@${row.updated_at.toISOString()}`;

      if (existing && force) {
        await prisma.htmlIncrementalSkillOutput.update({
          where: { id: existing.id },
          data:  {
            raw_html:     row.raw_html,
            text_summary,
            prompt_v,
            call_id:      'seeded',
            model:        row.model,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cost_usd:     row.cost_usd,
            is_historic:  true,
          },
        });
      } else {
        await prisma.htmlIncrementalSkillOutput.create({
          data: {
            skill_id:     targetSkill.id,
            ticker:       row.ticker,
            call_id:      'seeded',
            fiscal_year:  row.fiscal_year ?? null,
            quarter:      row.quarter     ?? null,
            raw_html:     row.raw_html,
            text_summary,
            prompt_v,
            model:        row.model,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cost_usd:     row.cost_usd,
            is_historic:  true,
          },
        });
      }

      process.stdout.write(`  SEED  ${row.ticker.padEnd(16)} fiscal=${row.fiscal_year ?? 'null'} q=${row.quarter ?? 'null'} — summary: ${text_summary.length} chars\n`);
      seeded++;
    } catch (err) {
      console.error(`  FAIL  ${row.ticker}: ${err.message}`);
      failed++;
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
