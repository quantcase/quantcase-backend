#!/usr/bin/env node
'use strict';

/**
 * Run L2 lens computation for the latest quarter of every unique company.
 *
 * Usage:
 *   node scripts/analysis/analyze_L2_all.js
 *   node scripts/analysis/analyze_L2_all.js --dispatch
 *   node scripts/analysis/analyze_L2_all.js --dispatch --base-url http://localhost:9000
 *
 * Flags:
 *   --dispatch            Call POST /api/lenses/compute for the latest call of each company (2 s stagger)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function computeLenses(callId) {
  const url = `${baseUrl}/api/lenses/compute`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // Omit `lenses` so the API uses all active LensConfigs from the database
      body:    JSON.stringify({ callId }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  enqueued lenses → ${callId}  (${body.count} jobs queued)`);
    } else {
      console.warn(`  [${res.status}] compute lenses → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] compute lenses → ${callId}  ${err.message}`);
  }
}

async function main() {
  // Load all 12 active lens slugs from DB — single source of truth
  const lensConfigs = await prisma.lensConfig.findMany({
    where:  { is_active: true },
    select: { slug: true },
  });
  const ALL_LENSES = new Set(lensConfigs.map((c) => c.slug));
  const totalLenses = ALL_LENSES.size;
  console.log(`\nActive lenses (${totalLenses}): ${[...ALL_LENSES].sort().join(', ')}`);

  // Load all fresh lens_scores into a map: call_id -> Set<lens_slug>
  const lensRows = await prisma.lensScore.findMany({
    where:  { is_stale: false },
    select: { call_id: true, lens_slug: true },
  });
  const l2Done = new Map(); // call_id -> Set of covered lens slugs
  for (const r of lensRows) {
    if (!l2Done.has(r.call_id)) l2Done.set(r.call_id, new Set());
    l2Done.get(r.call_id).add(r.lens_slug);
  }

  // Single bulk query: latest call_id per ticker from L1 (extracted_signals)
  const latestSignals = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (ticker) ticker, call_id, fiscal_year, quarter
    FROM extracted_signals
    WHERE is_invalidated = false AND ticker IS NOT NULL AND ticker <> ''
    ORDER BY ticker, fiscal_year DESC, quarter DESC
  `);

  console.log(`\nFound ${latestSignals.length} unique tickers in L1.\n`);

  console.log(
    'Ticker'.padEnd(20),
    'Latest Call ID'.padEnd(40),
    'FY'.padEnd(8),
    'Q'.padEnd(4),
    'Missing lenses'
  );
  console.log('-'.repeat(120));

  const todo = [];
  let skipped = 0;

  for (const signal of latestSignals) {
    const covered    = l2Done.get(signal.call_id) ?? new Set();
    const missingSet = [...ALL_LENSES].filter((s) => !covered.has(s));

    if (missingSet.length === 0) {
      skipped++;
      continue; // already fully covered — skip
    }

    todo.push(signal);
    console.log(
      (signal.ticker      ?? '').padEnd(20),
      (signal.call_id     ?? '').padEnd(40),
      (signal.fiscal_year ?? '').padEnd(8),
      (signal.quarter     ?? '').padEnd(4),
      missingSet.join(', ')
    );
  }

  console.log(`\nAlready complete: ${skipped} | Needs L2: ${todo.length} | Total: ${latestSignals.length}\n`);

  if (!dispatch) {
    console.log('Run with --dispatch to compute lenses for each call.\n');
    return;
  }

  console.log(`Dispatching L2 lens compute to ${baseUrl} (2 s stagger between calls)...\n`);
  console.log('Lenses: all active LensConfigs from DB\n');

  for (let i = 0; i < todo.length; i++) {
    await computeLenses(todo[i].call_id);
    if (i < todo.length - 1) await sleep(2000);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
