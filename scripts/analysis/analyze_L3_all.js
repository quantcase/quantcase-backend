#!/usr/bin/env node
'use strict';

/**
 * Run L3 analysis (aiInsightSynthesis) for the latest quarter of every unique company.
 *
 * Usage:
 *   node scripts/analysis/analyze_L3_all.js
 *   node scripts/analysis/analyze_L3_all.js --dispatch
 *   node scripts/analysis/analyze_L3_all.js --dispatch --base-url http://localhost:9000
 *   node scripts/analysis/analyze_L3_all.js --dispatch --force-refresh
 *   node scripts/analysis/analyze_L3_all.js --dispatch --fix-missing
 *
 * Flags:
 *   --dispatch            Call POST /api/analysis for the latest call of each company (2 s stagger)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 *   --force-refresh       Pass forceRefresh: true to bypass existing cached insights
 *   --fix-missing         Also re-run tickers whose existing L3 insight has score=0 (bad LLM run)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args         = process.argv.slice(2);
const dispatch     = args.includes('--dispatch');
const forceRefresh = args.includes('--force-refresh');
const fixMissing   = args.includes('--fix-missing');
const buIdx        = args.indexOf('--base-url');
const baseUrl      = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const TYPES = ['management', 'opportunity', 'deal'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enqueueAnalysis(callId, types) {
  const url = `${baseUrl}/api/analysis`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callId, types, forceRefresh }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const jobIds = (body.jobs ?? []).map(j => j.jobId).join(', ');
      console.log(`  [OK]  enqueued → ${callId}  types: [${types.join(', ')}]  (jobs: ${jobIds})`);
    } else {
      console.warn(`  [${res.status}] failed → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

async function main() {
  // Single bulk query: latest call_id per ticker from L2 (lens_scores)
  const latestScores = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (ticker) ticker, call_id
    FROM lens_scores
    WHERE is_stale = false AND ticker IS NOT NULL AND ticker <> ''
    ORDER BY ticker, call_id DESC
  `);

  console.log(`\nFound ${latestScores.length} unique tickers in L2.\n`);

  // Load existing L3 records: ticker -> Set<type>
  const l3Rows = await prisma.aiInsight.findMany({
    where: { type: { in: TYPES } },
    select: { ticker: true, type: true, insight: true },
  });
  const l3Done = new Map(); // ticker -> Set<type>
  for (const r of l3Rows) {
    // With --fix-missing, treat score=0 records as not done so they get re-dispatched.
    if (fixMissing && (r.insight?.score ?? 0) === 0) continue;
    if (!l3Done.has(r.ticker)) l3Done.set(r.ticker, new Set());
    l3Done.get(r.ticker).add(r.type);
  }

  console.log(
    'Ticker'.padEnd(20),
    'Latest Call ID'.padEnd(40),
    'Missing types'
  );
  console.log('-'.repeat(90));

  const todo = [];
  let skipped = 0;

  for (const score of latestScores) {
    const covered    = l3Done.get(score.ticker) ?? new Set();
    const missingSet = TYPES.filter((t) => !covered.has(t));

    if (missingSet.length === 0) {
      skipped++;
      continue; // already fully covered — skip
    }

    todo.push({ ...score, missingTypes: missingSet });
    console.log(
      (score.ticker  ?? '').padEnd(20),
      (score.call_id ?? '').padEnd(40),
      missingSet.join(', ')
    );
  }

  console.log(`\nAlready complete: ${skipped} | Needs L3: ${todo.length} | Total: ${latestScores.length}\n`);

  if (!dispatch) {
    console.log('Run with --dispatch to enqueue L3 analysis for each call.\n');
    return;
  }

  if (fixMissing && !forceRefresh) {
    console.warn('WARNING: --fix-missing is set but --force-refresh is not. The API may return cached score=0 results. Add --force-refresh to overwrite them.\n');
  }

  console.log(`Dispatching L3 analysis to ${baseUrl} (2 s stagger between calls)...\n`);
  console.log(`Flags: fix-missing=${fixMissing}  force-refresh=${forceRefresh}\n`);

  for (let i = 0; i < todo.length; i++) {
    await enqueueAnalysis(todo[i].call_id, todo[i].missingTypes);
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
