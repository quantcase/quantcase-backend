#!/usr/bin/env node
'use strict';

/**
 * List all earnings calls for a given company symbol and optionally dispatch
 * L1 extraction jobs (summarize + extract-prowess) for each call.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1.js <SYMBOL> [--dispatch] [--base-url <url>]
 *
 * Flags:
 *   --dispatch            Queue summarize + extract-prowess for every call (2 s stagger between calls)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 *
 * Examples:
 *   node scripts/analysis/analyze_L1.js INFY
 *   node scripts/analysis/analyze_L1.js INFY --dispatch
 *   node scripts/analysis/analyze_L1.js INFY --dispatch --base-url http://localhost:9000
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args     = process.argv.slice(2);
const symbol   = args[0];
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

if (!symbol) {
  console.error('Usage: node scripts/analysis/analyze_L1.js <SYMBOL> [--dispatch] [--base-url <url>]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId, endpoint) {
  const url = `${baseUrl}/api/calls/${callId}/${endpoint}`;
  try {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  POST ${endpoint.padEnd(16)} → ${callId}  (jobId: ${body.jobId ?? body.id ?? 'n/a'})`);
    } else {
      console.warn(`  [${res.status}] POST ${endpoint.padEnd(16)} → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] POST ${endpoint.padEnd(16)} → ${callId}  ${err.message}`);
  }
}

async function main() {
  const calls = await prisma.earnings_calls.findMany({
    where: { company: symbol },
    select: {
      id: true,
      company: true,
      company_name: true,
      fiscal_year: true,
      quarter: true,
      call_date: true,
      basic_industry: true,
    },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  if (calls.length === 0) {
    console.log(`No earnings calls found for symbol: ${symbol}`);
    return;
  }

  console.log(`\nEarnings calls for ${symbol} (${calls.length} total)\n`);
  console.log(
    'ID'.padEnd(40),
    'Company Name'.padEnd(30),
    'FY'.padEnd(8),
    'Q'.padEnd(4),
    'Date'.padEnd(14),
    'Industry'
  );
  console.log('-'.repeat(120));

  for (const c of calls) {
    console.log(
      (c.id ?? '').padEnd(40),
      (c.company_name ?? '').padEnd(30),
      (c.fiscal_year ?? '').padEnd(8),
      (c.quarter ?? '').padEnd(4),
      (c.call_date ?? '').padEnd(14),
      c.basic_industry ?? ''
    );
  }
  console.log();

  if (!dispatch) return;

  console.log(`\nDispatching L1 jobs to ${baseUrl} (2 s stagger between calls)...\n`);

  for (let i = 0; i < calls.length; i++) {
    const { id: callId } = calls[i];
    // Fire both jobs in parallel for this callId
    await Promise.all([
      postJob(callId, 'summarize'),
      postJob(callId, 'extract-prowess'),
    ]);
    // Wait 2 s before queuing the next callId (skip delay after last one)
    if (i < calls.length - 1) await sleep(2000);
  }

  console.log('\nAll jobs queued.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
