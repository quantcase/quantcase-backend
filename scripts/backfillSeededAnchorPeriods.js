#!/usr/bin/env node
'use strict';

/**
 * Backfill call_id/fiscal_year/quarter on seeded HtmlIncrementalSkillOutput rows.
 *
 * The original full-run flow (HtmlSkillOutput) never tracked which period its
 * output reflected, so every row seeded via seedIncrementalFromFullRun.js has
 * call_id: 'seeded' and fiscal_year/quarter = null. Without a real anchor,
 * incremental runs can't tell "what's new since this base" and fall back to no
 * lower bound — which lets old signals leak into the incremental SIGNALS block,
 * duplicating what the base's own narrative (L2) is already supposed to cover.
 *
 * For each ticker, this finds the single most recent signal across all doc types
 * (transcript/ppt/annual_report) in the L1 signal table by parsed period rank,
 * and copies that signal's own call_id/fiscal_year/quarter onto all of that
 * ticker's seeded rows — one source of truth, no cross-referencing between
 * tables or guessing at what the original run actually covered.
 *
 * Usage: node scripts/backfillSeededAnchorPeriods.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');

function parseFiscalYear(fy) {
  if (!fy) return null;
  const m = String(fy).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function parseQuarterNum(q) {
  if (!q) return null;
  const m = String(q).match(/(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

// Comparable rank across all doc types. Annual reports have no quarter and are
// typically published after all four quarters of their fiscal year close, so
// they rank just after Q4 of the same year.
function periodRank(fiscal_year, quarter, source_doc_type) {
  const year = parseFiscalYear(fiscal_year);
  if (year == null) return null;
  if (source_doc_type === 'annual_report') return year * 10 + 5;
  return year * 10 + (parseQuarterNum(quarter) ?? 0);
}

async function main() {
  const tickers = await prisma.htmlIncrementalSkillOutput.findMany({
    where:    { call_id: 'seeded', fiscal_year: null },
    select:   { ticker: true },
    distinct: ['ticker'],
  });
  console.log(`\n${tickers.length} tickers with seeded rows to backfill\n`);

  let updated = 0, skipped = 0, failed = 0;

  for (const { ticker } of tickers) {
    try {
      const calls = await prisma.transcriptSignalV2.findMany({
        where:    { ticker, is_invalidated: false },
        select:   { call_id: true, fiscal_year: true, quarter: true, source_doc_type: true },
        distinct: ['call_id'],
      });

      let best = null, bestRank = -Infinity;
      for (const c of calls) {
        const rank = periodRank(c.fiscal_year, c.quarter, c.source_doc_type);
        if (rank != null && rank > bestRank) { bestRank = rank; best = c; }
      }

      if (!best) {
        console.log(`  SKIP  ${ticker.padEnd(16)} — no resolvable periods found`);
        skipped++;
        continue;
      }

      const result = await prisma.htmlIncrementalSkillOutput.updateMany({
        where: { ticker, call_id: 'seeded', fiscal_year: null },
        data:  { call_id: best.call_id, fiscal_year: best.fiscal_year, quarter: best.quarter },
      });

      console.log(`  BACKFILL  ${ticker.padEnd(16)} → ${best.call_id} (${best.fiscal_year} ${best.quarter ?? ''})  (${result.count} rows)`);
      updated += result.count;
    } catch (err) {
      console.error(`  FAIL  ${ticker}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone.`);
  console.log(`  Rows updated: ${updated}`);
  console.log(`  Tickers skipped (no periods): ${skipped}`);
  console.log(`  Tickers failed: ${failed}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
