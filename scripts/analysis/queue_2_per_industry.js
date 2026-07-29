#!/usr/bin/env node
'use strict';

/**
 * Queue up to 2 companies per basic_industry, where:
 *   - All industries are launched IN PARALLEL
 *   - Within each industry, calls run SEQUENTIALLY:
 *       company1/call1 → company1/call2 → … → company2/call1 → company2/call2 → …
 *
 * Only dispatches calls that don't already have signals in extracted_signals.
 *
 * Usage:
 *   node scripts/analysis/queue_2_per_industry.js            # dry-run
 *   node scripts/analysis/queue_2_per_industry.js --dispatch
 *   node scripts/analysis/queue_2_per_industry.js --dispatch --base-url http://localhost:9000
 */

require('dotenv').config();
const prisma = require('../../config/prisma');
const { internalAuthHeaders } = require('../../lib/internalAuth');

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const STAGGER_MS = 2000; // between sequential posts within an industry chain

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId) {
  const url = `${baseUrl}/api/calls/${callId}/summarize`;
  try {
    const res  = await fetch(url, { method: 'POST', headers: internalAuthHeaders() });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      return `[OK]  jobId=${body.jobId ?? body.id ?? 'n/a'}`;
    } else {
      return `[${res.status}] ${JSON.stringify(body)}`;
    }
  } catch (err) {
    return `[ERR] ${err.message}`;
  }
}

/**
 * Sequentially dispatch all calls for a single industry (up to 2 companies,
 * all their calls in chronological order). Returns when the chain is fully enqueued.
 */
async function runIndustryChain(industry, companies, coveredCallIds) {
  const log = (msg) => console.log(`  [${industry}] ${msg}`);

  for (const { company, company_name, calls } of companies) {
    const pending = calls.filter((c) => !coveredCallIds.has(c.id));
    if (pending.length === 0) {
      log(`SKIP ${company} — all calls already extracted`);
      continue;
    }
    log(`${company} (${company_name}) — ${pending.length} calls to dispatch`);
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      const result = dispatch ? await postJob(c.id) : '[DRY RUN]';
      log(`  ${c.fiscal_year} ${c.quarter} → ${c.id}  ${result}`);
      if (dispatch && i < pending.length - 1) await sleep(STAGGER_MS);
    }
  }
}

async function main() {
  // 1. Call IDs that already have at least one valid signal
  const sigRows = await prisma.extractedSignal.groupBy({
    by: ['call_id'],
    where: { is_invalidated: false },
  });
  const coveredCallIds = new Set(sigRows.map((r) => r.call_id));

  // Tickers with signals (to identify already-covered companies)
  const tickerRows = await prisma.extractedSignal.groupBy({
    by: ['ticker'],
    where: { is_invalidated: false },
  });
  const coveredTickers = new Set(tickerRows.map((r) => r.ticker));

  console.log(`Covered call IDs: ${coveredCallIds.size}, covered tickers: ${coveredTickers.size}\n`);

  // 2. All calls with both texts, ordered for grouping
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

  // 3. Build industry → [company → calls[]] map, picking up to 2 uncovered companies
  const industryMap = {}; // industry → Array<{ company, company_name, calls[] }>

  for (const c of allCalls) {
    const ind = c.basic_industry || 'Unknown';
    if (!industryMap[ind]) industryMap[ind] = {};
    if (!industryMap[ind][c.company]) {
      industryMap[ind][c.company] = { company: c.company, company_name: c.company_name, calls: [] };
    }
    industryMap[ind][c.company].calls.push({ id: c.id, fiscal_year: c.fiscal_year, quarter: c.quarter });
  }

  // For each industry pick up to 2 companies that don't yet have full signal coverage.
  // Prefer uncovered tickers first; if industry already has 2 covered tickers, skip.
  const industryChains = {}; // industry → Array<{ company, company_name, calls[] }>

  for (const [industry, companyMap] of Object.entries(industryMap)) {
    const uncovered = Object.values(companyMap).filter((c) => !coveredTickers.has(c.company));
    const picked = uncovered.slice(0, 2);
    if (picked.length === 0) continue; // all companies already covered
    industryChains[industry] = picked;
  }

  const totalIndustries = Object.keys(industryChains).length;
  const totalCalls = Object.values(industryChains).reduce(
    (sum, companies) => sum + companies.reduce((s, c) => s + c.calls.length, 0), 0
  );

  console.log(`Industries to process in parallel: ${totalIndustries}`);
  console.log(`Total calls to dispatch:           ${totalCalls}`);
  if (!dispatch) console.log('\n[DRY RUN] Pass --dispatch to queue these jobs.\n');

  // Print plan
  for (const [industry, companies] of Object.entries(industryChains).sort()) {
    console.log(`\n${industry}`);
    for (const { company, company_name, calls } of companies) {
      const pending = calls.filter((c) => !coveredCallIds.has(c.id));
      console.log(`  ${company} (${company_name}) — ${calls.length} calls, ${pending.length} not yet extracted`);
      for (const c of calls) {
        const status = coveredCallIds.has(c.id) ? '[done]' : '[queue]';
        console.log(`    ${status} ${c.fiscal_year} ${c.quarter}  ${c.id}`);
      }
    }
  }

  if (!dispatch) return;

  console.log(`\nLaunching ${totalIndustries} industry chains in parallel...\n`);

  // 4. Run all industry chains in parallel; each chain is sequential internally
  await Promise.all(
    Object.entries(industryChains).map(([industry, companies]) =>
      runIndustryChain(industry, companies, coveredCallIds)
    )
  );

  console.log('\nAll industry chains completed.\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
