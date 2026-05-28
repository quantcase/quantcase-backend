#!/usr/bin/env node
'use strict';

/**
 * Run L2 lens computation for the latest quarter of every unique company.
 *
 * Usage:
 *   node scripts/analysis/analyze_L2_all.js
 *   node scripts/analysis/analyze_L2_all.js --dispatch
 *   node scripts/analysis/analyze_L2_all.js --dispatch --base-url http://localhost:9000
 *   node scripts/analysis/analyze_L2_all.js --dispatch --deal-only
 *
 * Flags:
 *   --dispatch            Call POST /api/lenses/compute for the latest call of each company (2 s stagger)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 *   --deal-only           Restrict to the 4 deal lenses: earnings-forecast, target-price-matrix,
 *                         pe-rerating-potential, earning-quality. Treats stale records as missing
 *                         so companies that were fully computed but are now stale will be re-dispatched.
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const DEAL_SLUGS = new Set(['earnings-forecast', 'target-price-matrix', 'pe-rerating-potential', 'earning-quality']);

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const dealOnly = args.includes('--deal-only');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function computeLenses(callId, lenses) {
  const url = `${baseUrl}/api/lenses/compute`;
  try {
    // When lenses array is provided, restrict to those slugs; otherwise API uses all active LensConfigs
    const payload = lenses ? { callId, lenses } : { callId };
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
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
  // Load active lens slugs — filtered to deal-only if requested
  const lensConfigs = await prisma.lensConfig.findMany({
    where:  { is_active: true, ...(dealOnly ? { slug: { in: [...DEAL_SLUGS] } } : {}) },
    select: { slug: true },
  });
  const ALL_LENSES = new Set(lensConfigs.map((c) => c.slug));
  const totalLenses = ALL_LENSES.size;
  const modeLabel = dealOnly ? 'deal-only' : 'all';
  console.log(`\nActive lenses [${modeLabel}] (${totalLenses}): ${[...ALL_LENSES].sort().join(', ')}`);

  // Load fresh (non-stale) lens_scores into a map: call_id -> Set<lens_slug>
  // When --deal-only: stale records are NOT counted as covered, so they appear as missing and get re-dispatched
  const lensScoreWhere = { is_stale: false, ...(dealOnly ? { lens_slug: { in: [...DEAL_SLUGS] } } : {}) };
  const lensRows = await prisma.lensScore.findMany({
    where:  lensScoreWhere,
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
  console.log(`Lenses: ${dealOnly ? [...DEAL_SLUGS].join(', ') : 'all active LensConfigs from DB'}\n`);

  const lensesArg = dealOnly ? [...DEAL_SLUGS] : undefined;
  for (let i = 0; i < todo.length; i++) {
    await computeLenses(todo[i].call_id, lensesArg);
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
