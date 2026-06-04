#!/usr/bin/env node
'use strict';

/**
 * Mark stale and re-dispatch specific lenses for a targeted list of tickers.
 *
 * Usage:
 *   node scripts/analysis/recompute_targeted_lenses.js
 *   node scripts/analysis/recompute_targeted_lenses.js --dispatch
 *   node scripts/analysis/recompute_targeted_lenses.js --dispatch --base-url http://localhost:9000
 *
 * Flags:
 *   --dispatch         Enqueue lens compute jobs after marking stale (default: dry-run)
 *   --base-url <url>   API base URL (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

// const TARGET_TICKERS = ['HDFCBANK', 'AXISBANK', 'IDBI', 'ASIANPAINT', 'INDIGOPNTS', 'BERGEPAINT'];
const TARGET_TICKERS = ['AXISBANK'];

const TARGET_LENSES  = [
  // 'guidance-credibility',
  // 'disclosure-honesty',
  // 'capital-allocation',
  // 'promoter-activity',
  // 'industry-analysis',
  'financial-strength',
  // 'customer-distribution',
  // 'competition',
];

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
      console.log(`  [OK]  enqueued → ${callId}  (${body.count} jobs)`);
    } else {
      console.warn(`  [${res.status}] ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

async function main() {
  console.log(`\nTarget tickers : ${TARGET_TICKERS.join(', ')}`);
  console.log(`Target lenses  : ${TARGET_LENSES.join(', ')}\n`);

  // Resolve latest call_id per ticker from extracted_signals
  const [, latestSignals] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
    prisma.$queryRawUnsafe(`
      SELECT DISTINCT ON (ticker) ticker, call_id, fiscal_year, quarter
      FROM extracted_signals
      WHERE is_invalidated = false
        AND ticker = ANY(ARRAY[${TARGET_TICKERS.map((t) => `'${t}'`).join(',')}]::text[])
      ORDER BY ticker, fiscal_year DESC, quarter DESC
    `),
  ]);

  if (latestSignals.length === 0) {
    console.error('No signals found for the target tickers. Aborting.');
    process.exit(1);
  }

  console.log('Resolved latest calls:');
  console.log('Ticker'.padEnd(16), 'Call ID'.padEnd(40), 'FY'.padEnd(10), 'Q');
  console.log('-'.repeat(80));
  for (const s of latestSignals) {
    console.log(
      (s.ticker      ?? '').padEnd(16),
      (s.call_id     ?? '').padEnd(40),
      (s.fiscal_year ?? '').padEnd(10),
      s.quarter ?? ''
    );
  }

  const callIds = latestSignals.map((s) => s.call_id);

  if (!dispatch) {
    console.log('Dry-run complete. Run with --dispatch to mark stale and enqueue compute jobs.\n');
    return;
  }

  // Mark existing scores stale
  const { count: staleCount } = await prisma.lensScore.updateMany({
    where: {
      call_id:   { in: callIds },
      lens_slug: { in: TARGET_LENSES },
      is_stale:  false,
    },
    data: { is_stale: true },
  });
  console.log(`\nMarked ${staleCount} lens score rows as stale.\n`);

  console.log(`Dispatching to ${baseUrl} (2 s stagger)...\n`);
  for (let i = 0; i < latestSignals.length; i++) {
    await computeLenses(latestSignals[i].call_id, TARGET_LENSES);
    if (i < latestSignals.length - 1) await sleep(2000);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
