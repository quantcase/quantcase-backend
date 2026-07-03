#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 L1 extraction (transcript + PPT + annual report) for a fixed list of tickers.
 * Calls all three summarize endpoints for each ticker in TARGET_TICKERS.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_multi_all.js [--dispatch] [--limit <n>] [--latest [n]] [--force] [--all]
 *
 * Flags:
 *   --dispatch        Actually call the API (dry-run without this flag)
 *   --limit <n>       Only process the n most recent calls/reports per ticker (default: all)
 *   --latest [n]      Only process the n most recent quarters per ticker (default: 2)
 *   --force           Invalidate existing signals and reprocess
 *   --all             Use all distinct companies from DB instead of TARGET_TICKERS
 *
 * Env:
 *   API_URL           Base URL of the API server (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const TARGET_TICKERS = [
  'NMDC', 'MOIL', 'GRAVITA',
  'BAJAJ-AUTO', 'TVSMOTOR', 'EICHERMOT',
  'ASIANPAINT', 'BERGEPAINT', 'KANSAINER',
  'RELIANCE', 'IOC', 'BPCL',
  'HATSUN', 'HERITGFOOD', 'PARAGMILK',
  'DABUR', 'GODREJCP', 'COLPAL',
  'HDFCAMC', 'NAM-INDIA', 'UTIAMC',
  'SBIN', 'BANKBARODA', 'CANBK',
  'BAJFINANCE', 'SHRIRAMFIN', 'CHOLAFIN',
  'APOLLOHOSP', 'MAXHEALTH', 'FORTIS',
  'HAL', 'BEL', 'BDL',
  'CUMMINSIND', 'KSB', 'KIRLOSBROS',
  'MAZDOCK', 'COCHINSHIP', 'SWANDEF',
  'TCS', 'INFY', 'HCLTECH',
  'SCI', 'GESHIP', 'TRANSWORLD',
  'BHARTIARTL', 'TATACOMM', 'TTML',
  'INDUSTOWER', 'HFCL', 'VINDHYATEL',
  'TATAPOWER', 'ADANIPOWER', 'TORNTPOWER',
  'WABAG', 'IONEXCHANG', 'JITFINFRA',
  'HDFCBANK', 'AXISBANK', 'IDBI', 
  'INDIGOPNTS', 'MSUMI', 'IEX'
];
// const TARGET_TICKERS = ['CANBK', 'MSUMI', 'IEX'];

const API_URL = process.env.API_URL || 'http://localhost:8000';

const args      = process.argv.slice(2);
const dispatch  = args.includes('--dispatch');
const force     = args.includes('--force');
const allMode   = args.includes('--all');
const arOnly    = args.includes('--ar-only');
const noAr      = args.includes('--no-ar');
const limIdx    = args.indexOf('--limit');
const startIdx  = args.indexOf('--start-from');
const startFrom = startIdx !== -1 ? args[startIdx + 1].toUpperCase() : null;

const latestIdx = args.indexOf('--latest');
const latestArg = latestIdx !== -1 ? args[latestIdx + 1] : null;
const latestN   = latestIdx !== -1
  ? (latestArg && /^\d+$/.test(latestArg) ? parseInt(latestArg, 10) : 2)
  : null;

const limit = latestN ?? (limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : null);

// ── Transcript helpers ────────────────────────────────────────────────────────

async function hasV2Signals(callId) {
  const count = await prisma.transcriptSignalV2.count({
    where: { call_id: callId, is_invalidated: false, source_doc_type: 'transcript' },
  });
  return count > 0;
}

async function invalidateV2Signals(callId) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: { call_id: callId, is_invalidated: false, source_doc_type: 'transcript' },
    data:  { is_invalidated: true },
  });
  return result.count;
}

async function dispatchV2(callId) {
  const res  = await fetch(`${API_URL}/api/calls/${callId}/summarize-v2`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── PPT helpers ───────────────────────────────────────────────────────────────

async function hasPptSignals(callId) {
  const count = await prisma.transcriptSignalV2.count({
    where: { call_id: callId, is_invalidated: false, source_doc_type: 'ppt' },
  });
  return count > 0;
}

async function invalidatePptSignals(callId) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: { call_id: callId, is_invalidated: false, source_doc_type: 'ppt' },
    data:  { is_invalidated: true },
  });
  return result.count;
}

async function dispatchPpt(callId) {
  const res  = await fetch(`${API_URL}/api/calls/${callId}/summarize-v2-ppt`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── Annual report helpers ─────────────────────────────────────────────────────

async function hasArSignals(reportId) {
  const count = await prisma.transcriptSignalV2.count({
    where: { call_id: reportId.toString(), is_invalidated: false, source_doc_type: 'annual_report' },
  });
  return count > 0;
}

async function invalidateArSignals(reportId) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: { call_id: reportId.toString(), is_invalidated: false, source_doc_type: 'annual_report' },
    data:  { is_invalidated: true },
  });
  return result.count;
}

async function dispatchAr(reportId) {
  const res  = await fetch(`${API_URL}/api/annual-reports/${reportId}/summarize-v2`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── Bulk prefetch helpers ─────────────────────────────────────────────────────

async function fetchActiveCallIds(types, scopeCallIds) {
  const where = { type: { in: types }, status: { in: ['pending', 'processing'] } };
  if (scopeCallIds !== null) where.callId = { in: scopeCallIds };
  const rows = await prisma.job.findMany({ where, select: { callId: true } });
  return new Set(rows.map(r => r.callId));
}

async function fetchDoneCallIds(sourceDocType, scopeCallIds) {
  const where = { is_invalidated: false, source_doc_type: sourceDocType };
  if (scopeCallIds !== null) where.call_id = { in: scopeCallIds };
  const rows = await prisma.transcriptSignalV2.findMany({
    where,
    select:   { call_id: true },
    distinct: ['call_id'],
  });
  return new Set(rows.map(r => r.call_id));
}

// ── Per-ticker processors ─────────────────────────────────────────────────────

async function processTranscripts(symbol, queuedIds, doneIds) {
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, quarter: true, transcript_url: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  const calls = limit ? allCalls.slice(0, limit) : allCalls;
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c.transcript_url) { noSource++; continue; }

    if (queuedIds.has(c.id)) {
      console.log(`    [SKIP] transcript ${c.id} — already in queue`);
      skipped++; continue;
    }

    if (doneIds.has(c.id)) {
      if (!force) { skipped++; continue; }
      const n = await invalidateV2Signals(c.id);
      doneIds.delete(c.id);
      console.log(`    [FORCE] transcript ${c.id} — invalidated ${n} signals`);
    }

    try {
      const result = await dispatchV2(c.id);
      console.log(`    [OK] transcript ${c.id} ${c.fiscal_year} ${c.quarter} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`    [FAIL] transcript ${c.id} — ${err.message}`);
      failed++;
    }
  }

  return { total: calls.length, queued, skipped, noSource, failed };
}

async function processPpts(symbol, queuedIds, doneIds) {
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, quarter: true, ppt_url: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  const calls = limit ? allCalls.slice(0, limit) : allCalls;
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c.ppt_url) { noSource++; continue; }

    if (queuedIds.has(c.id)) {
      console.log(`    [SKIP] ppt ${c.id} — already in queue`);
      skipped++; continue;
    }

    if (doneIds.has(c.id)) {
      if (!force) { skipped++; continue; }
      const n = await invalidatePptSignals(c.id);
      doneIds.delete(c.id);
      console.log(`    [FORCE] ppt ${c.id} — invalidated ${n} signals`);
    }

    try {
      const result = await dispatchPpt(c.id);
      console.log(`    [OK] ppt ${c.id} ${c.fiscal_year} ${c.quarter} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`    [FAIL] ppt ${c.id} — ${err.message}`);
      failed++;
    }
  }

  return { total: calls.length, queued, skipped, noSource, failed };
}

async function processAnnualReports(symbol, queuedIds, doneIds) {
  const allReports = await prisma.annual_reports.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, annual_report_url: true },
    orderBy: { fiscal_year: 'desc' },
  });

  const arLimit = limit ?? 3;
  const reports = allReports.slice(0, arLimit);
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    if (!r.annual_report_url) { noSource++; continue; }

    if (queuedIds.has(r.id.toString())) {
      console.log(`    [SKIP] ar ${r.id} — already in queue`);
      skipped++; continue;
    }

    const isDone = doneIds === null ? await hasArSignals(r.id) : doneIds.has(r.id.toString());
    if (isDone) {
      if (!force) { skipped++; continue; }
      const n = await invalidateArSignals(r.id);
      if (doneIds !== null) doneIds.delete(r.id.toString());
      console.log(`    [FORCE] ar ${r.id} — invalidated ${n} signals`);
    }

    try {
      const result = await dispatchAr(r.id);
      console.log(`    [OK] ar ${r.id} ${r.fiscal_year} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`    [FAIL] ar ${r.id} — ${err.message}`);
      failed++;
    }
  }

  return { total: reports.length, queued, skipped, noSource, failed };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let tickers = TARGET_TICKERS;
  if (allMode) {
    const rows = await prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] });
    tickers = rows.map(r => r.company).filter(Boolean).sort();
  }

  if (startFrom) {
    tickers = tickers.filter(t => t.toUpperCase() >= startFrom);
  }

  console.log(`\nTarget tickers (${tickers.length}): ${allMode ? '[all from DB]' : tickers.join(', ')}`);
  const limitLabel = latestN != null ? ` (--latest ${latestN})` : (limit ? ` (--limit ${limit})` : '');
  console.log(`Mode: ${dispatch ? `dispatch → ${API_URL}` : 'dry-run'}${force ? ' (--force)' : ''}${allMode ? ' (--all)' : ''}${arOnly ? ' (--ar-only)' : ''}${limitLabel}${startFrom ? ` (--start-from ${startFrom})` : ''}\n`);

  if (!dispatch) {
    const arLimit = limit ?? 3;
    for (const symbol of tickers) {
      const [calls, reports] = await Promise.all([
        arOnly ? Promise.resolve([]) : prisma.earnings_calls.findMany({
          where:   { company: symbol },
          select:  { id: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
          orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
        }),
        prisma.annual_reports.findMany({
          where:   { company: symbol },
          select:  { id: true, fiscal_year: true, annual_report_url: true },
          orderBy: { fiscal_year: 'desc' },
        }),
      ]);

      const shown        = limit ? calls.slice(0, limit) : calls;
      const shownReports = reports.slice(0, arLimit);

      if (arOnly) {
        console.log(`${symbol}: ${shownReports.length} annual reports (of ${reports.length})`);
      } else {
        console.log(`${symbol}: ${shown.length} calls (of ${calls.length}), ${shownReports.length} annual reports (of ${reports.length})`);
        console.log('  Calls:');
        for (const c of shown) {
          console.log(`    ${(c.id ?? '').padEnd(40)} FY${c.fiscal_year} ${(c.quarter ?? '').padEnd(4)}  transcript:${c.transcript_url ? 'yes' : 'no'}  ppt:${c.ppt_url ? 'yes' : 'no'}`);
        }
      }
      console.log('  Annual Reports:');
      for (const r of shownReports) {
        console.log(`    id:${r.id.toString().padEnd(8)} FY${r.fiscal_year}  url:${r.annual_report_url ? 'yes' : 'no'}`);
      }
      console.log();
    }
    console.log('Dry run — pass --dispatch to call the API.\n');
    return;
  }

  const totals = { queued: 0, skipped: 0, noSource: 0, failed: 0 };

  let scopeCallIds = null;
  if (!allMode) {
    console.log('Prefetching call IDs for target tickers...');
    const scopeCallRows = await prisma.earnings_calls.findMany({
      where:  { company: { in: tickers } },
      select: { id: true },
    });
    scopeCallIds = scopeCallRows.map(r => r.id);
    console.log(`  scoped to ${scopeCallIds.length} calls across ${tickers.length} tickers`);
  } else {
    console.log('Prefetching unscoped (--all mode — skipping IN filter)...');
  }

  console.log('Prefetching completed signals and active queue...');
  const [txQueuedIds, pptQueuedIds, arQueuedIds, txDoneIds, pptDoneIds, arDoneIds] = await Promise.all([
    arOnly  ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2'], scopeCallIds),
    arOnly  ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2_ppt'], scopeCallIds),
    noAr    ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2_annual_report'], scopeCallIds),
    arOnly  ? Promise.resolve(new Set()) : fetchDoneCallIds('transcript', scopeCallIds),
    arOnly  ? Promise.resolve(new Set()) : fetchDoneCallIds('ppt', scopeCallIds),
    noAr    ? Promise.resolve(new Set()) : (scopeCallIds === null ? Promise.resolve(null) : fetchDoneCallIds('annual_report', scopeCallIds)),
  ]);
  console.log(`  done — transcript: ${txDoneIds.size}, ppt: ${pptDoneIds.size}, ar: ${arDoneIds === null ? 'lazy' : arDoneIds.size}`);
  console.log(`  queued — transcript: ${txQueuedIds.size}, ppt: ${pptQueuedIds.size}, ar: ${arQueuedIds.size}\n`);

  for (const symbol of tickers) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${symbol}`);
    console.log('─'.repeat(60));

    const srcs = [];

    if (!arOnly) {
      console.log('  [transcripts]');
      const tx = await processTranscripts(symbol, txQueuedIds, txDoneIds);
      console.log(`    → queued=${tx.queued} skipped=${tx.skipped} no-source=${tx.noSource} failed=${tx.failed}`);
      srcs.push(tx);

      console.log('  [ppts]');
      const pp = await processPpts(symbol, pptQueuedIds, pptDoneIds);
      console.log(`    → queued=${pp.queued} skipped=${pp.skipped} no-source=${pp.noSource} failed=${pp.failed}`);
      srcs.push(pp);
    }

    if (!noAr) {
      console.log('  [annual reports]');
      const ar = await processAnnualReports(symbol, arQueuedIds, arDoneIds);
      console.log(`    → queued=${ar.queued} skipped=${ar.skipped} no-source=${ar.noSource} failed=${ar.failed}`);
      srcs.push(ar);
    }

    for (const src of srcs) {
      totals.queued   += src.queued;
      totals.skipped  += src.skipped;
      totals.noSource += src.noSource;
      totals.failed   += src.failed;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  TOTAL  queued=${totals.queued}  skipped=${totals.skipped}  no-source=${totals.noSource}  failed=${totals.failed}`);
  console.log('─'.repeat(60) + '\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
