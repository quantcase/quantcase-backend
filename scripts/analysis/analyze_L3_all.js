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
 *
 * Flags:
 *   --dispatch            Call POST /api/analysis for the latest call of each company (2 s stagger)
 *   --base-url <url>      API base URL (default: http://localhost:8000)
 *   --force-refresh       Pass forceRefresh: true to bypass existing cached insights
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args         = process.argv.slice(2);
const dispatch     = args.includes('--dispatch');
const forceRefresh = args.includes('--force-refresh');
const buIdx        = args.indexOf('--base-url');
const baseUrl      = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const TYPES = ['management', 'opportunity', 'deal'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enqueueAnalysis(callId) {
  const url = `${baseUrl}/api/analysis`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callId, types: TYPES, forceRefresh }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const jobIds = (body.jobs ?? []).map(j => j.jobId).join(', ');
      console.log(`  [OK]  enqueued → ${callId}  (jobs: ${jobIds})`);
    } else {
      console.warn(`  [${res.status}] failed → ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

async function main() {
  const rows = await prisma.earnings_calls.groupBy({
    by: ['company'],
    where: {
      OR: [
        { transcript_text: { not: null }, NOT: { transcript_text: '' } },
        { ppt_text: { not: null }, NOT: { ppt_text: '' } },
      ],
    },
    _count: { company: true },
    orderBy: { _count: { company: 'desc' } },
  });

  const companies = rows.map((r) => r.company);
  console.log(`\nFound ${companies.length} unique companies — dispatching L3 for latest quarter only.\n`);

  console.log(
    'Company'.padEnd(16),
    'Latest Call ID'.padEnd(40),
    'Company Name'.padEnd(30),
    'FY'.padEnd(8),
    'Q'.padEnd(4),
    'Date'
  );
  console.log('-'.repeat(120));

  const latest = [];
  for (const symbol of companies) {
    const call = await prisma.earnings_calls.findFirst({
      where: {
        company: symbol,
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
      },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });

    if (!call) continue;
    latest.push(call);

    console.log(
      (call.company ?? '').padEnd(16),
      (call.id ?? '').padEnd(40),
      (call.company_name ?? '').padEnd(30),
      (call.fiscal_year ?? '').padEnd(8),
      (call.quarter ?? '').padEnd(4),
      call.call_date ?? ''
    );
  }

  console.log(`\nTotal: ${latest.length} calls to process.\n`);

  if (!dispatch) {
    console.log('Run with --dispatch to enqueue L3 analysis for each call.\n');
    return;
  }

  console.log(`Dispatching L3 analysis to ${baseUrl} (2 s stagger between calls)...\n`);
  console.log(`Types: ${TYPES.join(', ')}${forceRefresh ? '  [force-refresh ON]' : ''}\n`);

  for (let i = 0; i < latest.length; i++) {
    await enqueueAnalysis(latest[i].id);
    if (i < latest.length - 1) await sleep(2000);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
