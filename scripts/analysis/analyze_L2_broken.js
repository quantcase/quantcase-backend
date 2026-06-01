#!/usr/bin/env node
'use strict';

/**
 * Run L2 lens computation only for lenses that are missing (null/zero score)
 * for each company's latest call in L1.
 *
 * Usage:
 *   node scripts/analysis/analyze_L2_broken.js
 *   node scripts/analysis/analyze_L2_broken.js --dispatch
 *   node scripts/analysis/analyze_L2_broken.js --dispatch --base-url http://localhost:9000
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function computeLenses(callId, lenses) {
  const url = `${baseUrl}/api/lenses/compute`;
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callId, lenses }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  enqueued → ${callId}  lenses: ${lenses.join(', ')}  (${body.count} jobs queued)`);
    } else {
      console.warn(`  [${res.status}] compute lenses → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] compute lenses → ${callId}  ${err.message}`);
  }
}

async function main() {
  // Load active lens slugs from DB
  const lensConfigs = await prisma.lensConfig.findMany({
    where:  { is_active: true },
    select: { slug: true },
  });
  const ALL_LENSES = new Set(lensConfigs.map((c) => c.slug));
  console.log(`\nActive lenses (${ALL_LENSES.size}): ${[...ALL_LENSES].sort().join(', ')}`);

  // Latest call per ticker from L1
  const latestSignals = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (ticker) ticker, call_id, fiscal_year, quarter
    FROM extracted_signals
    WHERE is_invalidated = false AND ticker IS NOT NULL AND ticker <> ''
    ORDER BY ticker, fiscal_year DESC, quarter DESC
  `);
  console.log(`\nFound ${latestSignals.length} unique tickers in L1.\n`);

  // For each latest call, find which lenses have a null or zero score
  // Query all lens_scores for these call_ids in one shot
  const callIds = latestSignals.map((s) => s.call_id);
  const lensRows = await prisma.$queryRawUnsafe(`
    SELECT call_id, lens_slug, (lens_data->>'score')::numeric AS score
    FROM lens_scores
    WHERE call_id = ANY($1::text[])
      AND is_stale = false
  `, callIds);

  // Build map: call_id -> Set of lens slugs that are properly populated
  const goodLenses = new Map();
  for (const row of lensRows) {
    const score  = row.score != null ? parseFloat(row.score) : null;
    const isGood = score != null;
    if (isGood) {
      if (!goodLenses.has(row.call_id)) goodLenses.set(row.call_id, new Set());
      goodLenses.get(row.call_id).add(row.lens_slug);
    }
  }

  console.log(
    'Ticker'.padEnd(20),
    'Latest Call ID'.padEnd(40),
    'FY'.padEnd(8),
    'Q'.padEnd(4),
    'Missing lenses'
  );
  console.log('-'.repeat(120));

  const todo    = [];
  let skipped   = 0;

  for (const signal of latestSignals) {
    const covered    = goodLenses.get(signal.call_id) ?? new Set();
    const missingSet = [...ALL_LENSES].filter((s) => !covered.has(s));

    if (missingSet.length === 0) {
      skipped++;
      continue;
    }

    todo.push({ ...signal, missingLenses: missingSet });
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
    console.log('Run with --dispatch to compute missing lenses for each call.\n');
    return;
  }

  console.log(`Dispatching to ${baseUrl} (2 s stagger between calls)...\n`);

  for (let i = 0; i < todo.length; i++) {
    await computeLenses(todo[i].call_id, todo[i].missingLenses);
    if (i < todo.length - 1) await sleep(1000);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
