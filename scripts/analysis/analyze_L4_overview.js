#!/usr/bin/env node
'use strict';

/**
 * Run L4 overview synthesis for the latest quarter of every unique company
 * that already has all three L3 lenses (management, opportunity, deal).
 *
 * Usage:
 *   node scripts/analysis/analyze_L4_overview.js
 *   node scripts/analysis/analyze_L4_overview.js --dispatch
 *   node scripts/analysis/analyze_L4_overview.js --dispatch --base-url http://localhost:9000
 *   node scripts/analysis/analyze_L4_overview.js --dispatch --force-refresh
 *
 * Flags:
 *   --dispatch            Call POST /api/analysis/overview for each eligible company (2 s stagger)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 *   --force-refresh       Pass forceRefresh: true to bypass existing cached overviews
 */

require('dotenv').config();
const prisma = require('../../config/prisma');
const { internalAuthHeaders } = require('../../lib/internalAuth');

const args         = process.argv.slice(2);
const dispatch     = args.includes('--dispatch');
const forceRefresh = args.includes('--force-refresh');
const buIdx        = args.indexOf('--base-url');
const baseUrl      = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const L3_REQUIRED = ['management', 'opportunity', 'deal'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enqueueOverview(callId) {
  const url = `${baseUrl}/api/analysis/overview`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { ...internalAuthHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callId, forceRefresh }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  enqueued → ${callId}  (jobId: ${body.data?.jobId ?? '?'})`);
    } else {
      console.warn(`  [${res.status}] failed → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

async function main() {
  // Latest call_id per ticker from L2
  const latestScores = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (ticker) ticker, call_id
    FROM lens_scores
    WHERE is_stale = false AND ticker IS NOT NULL AND ticker <> ''
    ORDER BY ticker, call_id DESC
  `);

  console.log(`\nFound ${latestScores.length} unique tickers in L2.\n`);

  // Tickers that have all 3 required L3 types
  const l3Rows = await prisma.aiInsight.findMany({
    where: { type: { in: L3_REQUIRED } },
    select: { ticker: true, type: true },
  });
  const l3Coverage = new Map(); // ticker -> Set<type>
  for (const r of l3Rows) {
    if (!l3Coverage.has(r.ticker)) l3Coverage.set(r.ticker, new Set());
    l3Coverage.get(r.ticker).add(r.type);
  }

  // Tickers that already have an overview
  const overviewRows = await prisma.aiInsight.findMany({
    where: { type: 'overview' },
    select: { ticker: true },
  });
  const hasOverview = new Set(overviewRows.map((r) => r.ticker));

  console.log(`Existing overviews in DB: ${hasOverview.size}\n`);

  console.log(
    'Ticker'.padEnd(20),
    'Latest Call ID'.padEnd(40),
    'Status'
  );
  console.log('-'.repeat(80));

  const todo   = [];
  let skipped  = 0;
  let noL3     = 0;

  for (const score of latestScores) {
    const covered = l3Coverage.get(score.ticker) ?? new Set();
    const missingL3 = L3_REQUIRED.filter((t) => !covered.has(t));

    if (missingL3.length > 0) {
      noL3++;
      continue; // missing required L3 lenses — skip
    }

    if (hasOverview.has(score.ticker) && !forceRefresh) {
      skipped++;
      continue; // already has overview
    }

    todo.push(score);
    console.log(
      (score.ticker  ?? '').padEnd(20),
      (score.call_id ?? '').padEnd(40),
      hasOverview.has(score.ticker) ? '(force-refresh)' : 'missing'
    );
  }

  console.log(`\nAlready complete: ${skipped} | Missing L3 (skipped): ${noL3} | Needs overview: ${todo.length} | Total: ${latestScores.length}\n`);

  if (!dispatch) {
    console.log('Run with --dispatch to enqueue overview synthesis for each company.\n');
    return;
  }

  console.log(`Dispatching L4 overview to ${baseUrl} (2 s stagger between calls)...\n`);
  console.log(`Flags: force-refresh=${forceRefresh}\n`);

  for (let i = 0; i < todo.length; i++) {
    await enqueueOverview(todo[i].call_id);
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
