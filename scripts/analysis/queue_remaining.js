#!/usr/bin/env node
'use strict';

/**
 * Queue all calls (company + fiscal_year + quarter combos) that do NOT yet
 * have any signals in extracted_signals.
 *
 * Run this AFTER bumping worker concurrency to 20 and after queue_2_per_industry
 * has finished seeding KPIs.
 *
 * Usage:
 *   node scripts/analysis/queue_remaining.js            # dry-run (shows count)
 *   node scripts/analysis/queue_remaining.js --dispatch
 *   node scripts/analysis/queue_remaining.js --dispatch --base-url http://localhost:9000
 */

require('dotenv').config();
const prisma = require('../../config/prisma');
const { internalAuthHeaders } = require('../../lib/internalAuth');

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const STAGGER_MS = 500; // shorter stagger — concurrency=20 will absorb it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId) {
  const url = `${baseUrl}/api/calls/${callId}/summarize`;
  try {
    const res  = await fetch(url, { method: 'POST', headers: internalAuthHeaders() });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  ${callId}  jobId=${body.jobId ?? body.id ?? 'n/a'}`);
    } else {
      console.warn(`  [${res.status}] ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

async function main() {
  // 1. call_ids that already have at least one valid signal
  const sigRows = await prisma.extractedSignal.groupBy({
    by: ['call_id'],
    where: { is_invalidated: false },
  });
  const coveredCallIds = new Set(sigRows.map((r) => r.call_id));
  console.log(`Call IDs already covered in extracted_signals: ${coveredCallIds.size}`);

  // 2. All calls with both texts present
  const allCalls = await prisma.earnings_calls.findMany({
    where: {
      AND: [
        { ppt_text: { not: null } }, { ppt_text: { not: '' } },
        { transcript_text: { not: null } }, { transcript_text: { not: '' } },
      ],
    },
    select: { id: true, company: true, company_name: true, fiscal_year: true, quarter: true, basic_industry: true },
    orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
  });

  // 3. Filter to those without signals
  const remaining = allCalls.filter((c) => !coveredCallIds.has(c.id));

  console.log(`\nTotal calls with both texts: ${allCalls.length}`);
  console.log(`Already extracted:           ${coveredCallIds.size}`);
  console.log(`Remaining to dispatch:       ${remaining.length}\n`);

  // Summary by industry
  const byIndustry = {};
  for (const c of remaining) {
    const ind = c.basic_industry || 'Unknown';
    byIndustry[ind] = (byIndustry[ind] ?? 0) + 1;
  }
  console.log('Breakdown by industry:');
  for (const [ind, count] of Object.entries(byIndustry).sort()) {
    console.log(`  ${ind.padEnd(45)} ${count}`);
  }

  if (!dispatch) {
    console.log('\n[DRY RUN] Pass --dispatch to queue these jobs.');
    return;
  }

  console.log(`\nDispatching to ${baseUrl} (${STAGGER_MS}ms stagger)...\n`);
  for (let i = 0; i < remaining.length; i++) {
    const c = remaining[i];
    if (i % 50 === 0) {
      console.log(`\n[${i + 1}/${remaining.length}] ${c.company} ${c.fiscal_year} ${c.quarter} — ${c.basic_industry}`);
    }
    await postJob(c.id);
    if (i < remaining.length - 1) await sleep(STAGGER_MS);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
