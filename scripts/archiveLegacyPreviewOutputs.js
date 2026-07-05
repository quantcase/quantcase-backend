#!/usr/bin/env node
'use strict';

/**
 * One-time archive: the old /api/html-skills/run-preview flow saved outputs
 * under a `__preview__` sentinel HtmlSkill row, one per ticker, keyed only by
 * a hash of the config (the actual skill_prompt/filters used were never
 * persisted — only the resulting HTML + model + tokens/cost were). That flow
 * is superseded by named HtmlIncrementalSkillConfig rows, which are real,
 * re-editable settings bundles rather than throwaway hashed previews.
 *
 * This script just archives the old outputs as read-only reference material
 * under a `__legacy_preview__` sentinel HtmlIncrementalSkill (is_historic:
 * true, since the old flow had no base/delta concept — every preview was a
 * full from-scratch run). It does NOT attempt to reconstruct configs from
 * them — there is nothing to reconstruct; the input settings were never
 * saved server-side.
 *
 * Non-destructive: old html_skill_outputs rows are left untouched.
 * Idempotent: skips tickers that already have an archived row.
 *
 * Usage: node scripts/archiveLegacyPreviewOutputs.js [--force]
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { stripHtmlToText } = require('../utils/stripHtml');

const OLD_PREVIEW_SLUG = '__preview__';
const ARCHIVE_SLUG     = '__legacy_preview__';
const force            = process.argv.includes('--force');

async function main() {
  const sourceSkill = await prisma.htmlSkill.findUnique({ where: { slug: OLD_PREVIEW_SLUG } });
  if (!sourceSkill) {
    console.log(`No "${OLD_PREVIEW_SLUG}" HtmlSkill found — nothing to archive.`);
    return;
  }

  const archiveSkill = await prisma.htmlIncrementalSkill.upsert({
    where:  { slug: ARCHIVE_SLUG },
    update: {},
    create: {
      slug:        ARCHIVE_SLUG,
      name:        'Legacy Preview Archive (system)',
      skill_prompt: 'archive',
      category:    'management',
      transcript_signal_types:    [],
      ppt_signal_types:           [],
      annual_report_signal_types: [],
      is_active:   false,
    },
  });

  const outputs = await prisma.htmlSkillOutput.findMany({ where: { skill_id: sourceSkill.id } });

  console.log(`\nSource: "${OLD_PREVIEW_SLUG}" (HtmlSkill) → ${outputs.length} outputs`);
  console.log(`Target: "${ARCHIVE_SLUG}" (HtmlIncrementalSkill, id: ${archiveSkill.id})`);
  console.log(`Mode:   ${force ? 'force (overwrite existing)' : 'skip existing'}\n`);

  let archived = 0, skipped = 0, failed = 0;

  for (const row of outputs) {
    try {
      const existing = await prisma.htmlIncrementalSkillOutput.findFirst({
        where: {
          skill_id:    archiveSkill.id,
          ticker:      row.ticker,
          fiscal_year: null,
          quarter:     null,
          is_historic: true,
        },
      });

      if (existing && !force) {
        skipped++;
        continue;
      }

      const text_summary = stripHtmlToText(row.raw_html);
      const data = {
        raw_html:      row.raw_html,
        text_summary,
        prompt_v:      row.prompt_v,
        call_id:       'legacy-preview',
        model:         row.model,
        input_tokens:  row.input_tokens,
        output_tokens: row.output_tokens,
        cost_usd:      row.cost_usd,
        is_historic:   true,
      };

      if (existing) {
        await prisma.htmlIncrementalSkillOutput.update({ where: { id: existing.id }, data });
      } else {
        await prisma.htmlIncrementalSkillOutput.create({
          data: { skill_id: archiveSkill.id, ticker: row.ticker, fiscal_year: null, quarter: null, ...data },
        });
      }

      console.log(`  ARCHIVE ${row.ticker.padEnd(16)} — summary: ${text_summary.length} chars`);
      archived++;
    } catch (err) {
      console.error(`  FAIL  ${row.ticker}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone.`);
  console.log(`  Archived: ${archived}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
