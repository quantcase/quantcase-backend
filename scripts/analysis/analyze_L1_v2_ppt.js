#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 PPT signal extraction for all earnings calls of a given symbol.
 * Calls POST /api/calls/:callId/summarize-v2-ppt for each call that has a
 * ppt_url and no existing v2 PPT signals.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_ppt.js <SYMBOL> [--dispatch] [--limit <n>] [--force]
 *
 * Flags:
 *   --dispatch        Actually call the API (dry-run without this flag)
 *   --limit <n>       Only process the n most recent calls (default: all)
 *   --force           Invalidate existing PPT signals and reprocess
 *
 * Env:
 *   API_URL           Base URL of the API server (default: http://localhost:8000)
 *
 * Example (dry-run):
 *   node scripts/analysis/analyze_L1_v2_ppt.js RELIANCE
 *
 * Example (dispatch 2 most recent):
 *   node scripts/analysis/analyze_L1_v2_ppt.js RELIANCE --dispatch --limit 2
 */

require('dotenv').config();
const prisma = require('../../config/prisma');
const { internalAuthHeaders } = require('../../lib/internalAuth');

const API_URL = process.env.API_URL || 'http://localhost:8000';

const args     = process.argv.slice(2);
const symbol   = args[0];
const dispatch = args.includes('--dispatch');
const force    = args.includes('--force');
const limIdx   = args.indexOf('--limit');
const limit    = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : null;

if (!symbol) {
  console.error('Usage: node scripts/analysis/analyze_L1_v2_ppt.js <SYMBOL> [--dispatch] [--limit <n>] [--force]');
  process.exit(1);
}

// PPT signals are identified by source_context values that are unique to the
// PPT extraction flow (none of these appear in transcript_call_v2).
const PPT_SOURCE_CONTEXTS = [
  'financial_actual', 'capex_actual', 'kpi_actual',
  'customer_concentration', 'distribution_channels',
  'product_technology', 'competitive_landscape',
  'disclosure_quality', 'industry_signals',
  'capital_allocation', 'earnings_quality', 'future_target',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasPptSignals(callId) {
  const count = await prisma.transcriptSignalV2.count({
    where: {
      call_id:        callId,
      is_invalidated: false,
      source_context: { in: PPT_SOURCE_CONTEXTS },
    },
  });
  return count > 0;
}

async function invalidatePptSignals(callId) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: {
      call_id:        callId,
      is_invalidated: false,
      source_context: { in: PPT_SOURCE_CONTEXTS },
    },
    data: { is_invalidated: true },
  });
  return result.count;
}

async function dispatchPpt(callId) {
  const res  = await fetch(`${API_URL}/api/calls/${callId}/summarize-v2-ppt`, { method: 'POST', headers: internalAuthHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function main() {
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: symbol },
    select:  {
      id: true, company: true,
      fiscal_year: true, quarter: true, call_date: true,
      basic_industry: true, ppt_url: true,
    },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  if (allCalls.length === 0) {
    console.log(`No earnings calls found for symbol: ${symbol}`);
    return;
  }

  const calls = limit ? allCalls.slice(0, limit) : allCalls;

  console.log(`\nEarnings calls for ${symbol} — ${calls.length} of ${allCalls.length} total${limit ? ` (limited to ${limit})` : ''}\n`);
  console.log('ID'.padEnd(40), 'FY'.padEnd(8), 'Q'.padEnd(4), 'Date'.padEnd(14), 'PPT'.padEnd(6), 'Industry');
  console.log('-'.repeat(120));

  for (const c of calls) {
    console.log(
      (c.id ?? '').padEnd(40),
      (c.fiscal_year ?? '').padEnd(8),
      (c.quarter ?? '').padEnd(4),
      (c.call_date ?? '').padEnd(14),
      (c.ppt_url ? 'yes' : 'no').padEnd(6),
      c.basic_industry ?? ''
    );
  }
  console.log();

  if (!dispatch) {
    console.log('Dry run — pass --dispatch to call the API.\n');
    return;
  }

  console.log(`Dispatching to ${API_URL}...\n`);
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];

    if (!c.ppt_url) {
      console.log(`  [SKIP] ${c.id}  — no PPT URL`);
      noSource++;
      continue;
    }

    const already = await hasPptSignals(c.id);
    if (already) {
      if (!force) {
        console.log(`  [SKIP] ${c.id}  — PPT signals already exist (use --force to reprocess)`);
        skipped++;
        continue;
      }
      const invalidated = await invalidatePptSignals(c.id);
      console.log(`  [FORCE] ${c.id}  — invalidated ${invalidated} existing PPT signals`);
    }

    try {
      const result = await dispatchPpt(c.id);
      console.log(`  [OK]   ${c.id}  ${c.fiscal_year} ${c.quarter}  — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`  [FAIL] ${c.id}  — ${err.message}`);
      failed++;
    }

    if (i < calls.length - 1) await sleep(300);
  }

  console.log(`\nDone. queued=${queued} jobs  skipped=${skipped}  no-source=${noSource}  failed=${failed}\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
