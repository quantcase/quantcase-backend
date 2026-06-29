#!/usr/bin/env node
'use strict';

/**
 * Run L1 analysis across all unique companies in earnings_calls.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_all.js
 *   node scripts/analysis/analyze_L1_all.js --dispatch
 *   node scripts/analysis/analyze_L1_all.js --dispatch --base-url http://localhost:9000
 *
 * Flags:
 *   --dispatch            Queue summarize + extract-prowess for every call (2 s stagger between calls)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args    = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx   = args.indexOf('--base-url');
const baseUrl = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId, endpoint) {
  const url = `${baseUrl}/api/calls/${callId}/${endpoint}`;
  try {
    const res  = await fetch(url, { method: 'POST' });
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
  const rows = await prisma.earnings_calls.groupBy({
    by: ['company'],
    _count: { company: true },
    orderBy: { _count: { company: 'desc' } },
  });

  const companies = rows.map((r) => r.company);
  // const companies = rows.map((r) => r.company).slice(0, 3); // TODO: remove slice to run on all companies
  console.log(`\nFound ${companies.length} unique companies.\n`);

  for (const symbol of companies) {
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
    calls.sort((a, b) => a.fiscal_year - b.fiscal_year || a.quarter.localeCompare(b.quarter));

    console.log(`\n=== ${symbol} (${calls.length} calls) ===`);
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

    if (!dispatch) continue;

    console.log(`\n  Dispatching jobs to ${baseUrl} (2 s stagger)...`);
    for (let i = 0; i < calls.length; i++) {
      const { id: callId } = calls[i];

      // Check which source types already have signals in the Signal Store
      const existingCounts = await prisma.extractedSignal.groupBy({
        by: ['source_type'],
        where: { call_id: callId, is_invalidated: false },
        _count: { source_type: true },
      });
      const done = new Set(existingCounts.filter((r) => r._count.source_type > 0).map((r) => r.source_type));

      const jobs = [];
      if (!done.has('transcript')) jobs.push(postJob(callId, 'summarize'));
      else console.log(`  [SKIP] summarize         → ${callId}  (transcript signals exist)`);

      if (!done.has('prowess'))    jobs.push(postJob(callId, 'extract-prowess'));
      else console.log(`  [SKIP] extract-prowess   → ${callId}  (prowess signals exist)`);

      if (jobs.length > 0) await Promise.all(jobs);
      if (i < calls.length - 1) await sleep(2000);
    }
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
