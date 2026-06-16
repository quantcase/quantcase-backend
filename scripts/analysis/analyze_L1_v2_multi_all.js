#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 L1 extraction (transcript + PPT + annual report) for a fixed list of tickers.
 * Calls all three summarize endpoints for each ticker in TARGET_TICKERS.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_multi_all.js [--dispatch] [--limit <n>] [--force] [--all]
 *
 * Flags:
 *   --dispatch        Actually call the API (dry-run without this flag)
 *   --limit <n>       Only process the n most recent calls/reports per ticker (default: all)
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

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const force    = args.includes('--force');
const allMode  = args.includes('--all');
const limIdx   = args.indexOf('--limit');
const limit    = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : null;

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

// ── Per-ticker processors ─────────────────────────────────────────────────────

async function processTranscripts(symbol) {
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

    const already = await hasV2Signals(c.id);
    if (already) {
      if (!force) { skipped++; continue; }
      const n = await invalidateV2Signals(c.id);
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

async function processPpts(symbol) {
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

    const already = await hasPptSignals(c.id);
    if (already) {
      if (!force) { skipped++; continue; }
      const n = await invalidatePptSignals(c.id);
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

async function processAnnualReports(symbol) {
  const allReports = await prisma.annual_reports.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, annual_report_url: true },
    orderBy: { fiscal_year: 'desc' },
  });

  const reports = limit ? allReports.slice(0, limit) : allReports;
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    if (!r.annual_report_url) { noSource++; continue; }

    const already = await hasArSignals(r.id);
    if (already) {
      if (!force) { skipped++; continue; }
      const n = await invalidateArSignals(r.id);
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

  console.log(`\nTarget tickers (${tickers.length}): ${allMode ? '[all from DB]' : tickers.join(', ')}`);
  console.log(`Mode: ${dispatch ? `dispatch → ${API_URL}` : 'dry-run'}${force ? ' (--force)' : ''}${allMode ? ' (--all)' : ''}${limit ? ` (--limit ${limit})` : ''}\n`);

  if (!dispatch) {
    for (const symbol of tickers) {
      const [calls, reports] = await Promise.all([
        prisma.earnings_calls.findMany({
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

      const shown        = limit ? calls.slice(0, limit)   : calls;
      const shownReports = limit ? reports.slice(0, limit) : reports;

      console.log(`${symbol}: ${shown.length} calls (of ${calls.length}), ${shownReports.length} annual reports (of ${reports.length})`);
      console.log('  Calls:');
      for (const c of shown) {
        console.log(`    ${(c.id ?? '').padEnd(40)} FY${c.fiscal_year} ${(c.quarter ?? '').padEnd(4)}  transcript:${c.transcript_url ? 'yes' : 'no'}  ppt:${c.ppt_url ? 'yes' : 'no'}`);
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

  for (const symbol of tickers) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${symbol}`);
    console.log('─'.repeat(60));

    console.log('  [transcripts]');
    const tx = await processTranscripts(symbol);
    console.log(`    → queued=${tx.queued} skipped=${tx.skipped} no-source=${tx.noSource} failed=${tx.failed}`);

    console.log('  [ppts]');
    const pp = await processPpts(symbol);
    console.log(`    → queued=${pp.queued} skipped=${pp.skipped} no-source=${pp.noSource} failed=${pp.failed}`);

    console.log('  [annual reports]');
    const ar = await processAnnualReports(symbol);
    console.log(`    → queued=${ar.queued} skipped=${ar.skipped} no-source=${ar.noSource} failed=${ar.failed}`);

    for (const src of [tx, pp, ar]) {
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
