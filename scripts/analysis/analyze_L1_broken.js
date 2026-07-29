#!/usr/bin/env node
'use strict';

/**
 * Find companies with missing prowess signals in L1 extracted_signals, then optionally dispatch jobs.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_broken.js
 *   node scripts/analysis/analyze_L1_broken.js --dispatch
 *   node scripts/analysis/analyze_L1_broken.js --dispatch --base-url http://localhost:9000
 *
 * Flags:
 *   --dispatch            Queue extract-prowess for every call missing prowess signals
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');
const { internalAuthHeaders } = require('../../lib/internalAuth');

const args    = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx   = args.indexOf('--base-url');
const baseUrl = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId, endpoint) {
  const url = `${baseUrl}/api/calls/${callId}/${endpoint}`;
  try {
    const res  = await fetch(url, { method: 'POST', headers: internalAuthHeaders() });
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
  // All calls that have text content
  const allCalls = await prisma.earnings_calls.findMany({
    where: {
      OR: [
        { transcript_text: { not: null }, NOT: { transcript_text: '' } },
        { ppt_text: { not: null }, NOT: { ppt_text: '' } },
      ],
    },
    select: {
      id: true,
      company: true,
      company_name: true,
      fiscal_year: true,
      quarter: true,
      call_date: true,
      basic_industry: true,
    },
    orderBy: [{ company: 'asc' }, { fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  // Calls that already have at least one non-invalidated prowess signal
  const withProwess = await prisma.extractedSignal.groupBy({
    by: ['call_id'],
    where: { source_type: 'prowess', is_invalidated: false },
    _count: { call_id: true },
  });
  const prowessCallIds = new Set(withProwess.map((r) => r.call_id));

  // Broken = calls that have text but no prowess signals
  const brokenCalls = allCalls.filter((c) => !prowessCallIds.has(c.id));

  // Group by company
  const byCompany = {};
  for (const c of brokenCalls) {
    if (!byCompany[c.company]) byCompany[c.company] = [];
    byCompany[c.company].push(c);
  }

  const companies = Object.keys(byCompany).sort();
  const totalBrokenCalls = brokenCalls.length;

  console.log(`\nTotal calls with text content : ${allCalls.length}`);
  console.log(`Calls with prowess signals    : ${prowessCallIds.size}`);
  console.log(`Calls missing prowess signals : ${totalBrokenCalls}`);
  console.log(`Unique companies affected      : ${companies.length}\n`);

  if (!dispatch) {
    console.log('Run with --dispatch to queue extract-prowess jobs for all broken calls.');
  } else {
    console.log(`Dispatching jobs to ${baseUrl} (2 s stagger)...\n`);
    let total = 0;
    for (const symbol of companies) {
      const calls = byCompany[symbol];
      console.log(`=== ${symbol} (${calls.length} calls) ===`);
      for (let i = 0; i < calls.length; i++) {
        await postJob(calls[i].id, 'extract-prowess');
        total++;
        if (i < calls.length - 1) await sleep(500);
      }
    }
    console.log(`\nDispatched ${total} jobs.`);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
