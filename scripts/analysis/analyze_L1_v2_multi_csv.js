#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 L1 extraction (transcript + PPT only) for the calls listed in the
 * "QC - Wrong Quarter Fixes" report, instead of a static ticker list.
 *
 * The report's `id` column is expected to match earnings_calls.id directly.
 * Rows whose id isn't found in the DB are reported as misses and skipped.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_multi_csv.js [--dispatch] [--force] [--csv <path>]
 *
 * Flags:
 *   --dispatch    Actually call the API (dry-run without this flag)
 *   --force       Invalidate existing signals and reprocess
 *   --csv <path>  Path to the report CSV (default: docs/QC - Wrong Quarter Fixes - FY25-26.csv)
 *
 * Env:
 *   API_URL       Base URL of the API server (default: http://localhost:8000)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const prisma = require('../../config/prisma');

const DEFAULT_CSV = path.join(__dirname, '../../docs/QC - Wrong Quarter Fixes - Pre-FY25.csv');

const API_URL = process.env.API_URL || 'http://localhost:8000';

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const force    = args.includes('--force');
const csvIdx   = args.indexOf('--csv');
const csvPath  = csvIdx !== -1 ? args[csvIdx + 1] : DEFAULT_CSV;

// ── CSV loading ───────────────────────────────────────────────────────────────

function loadCallIdsFromCsv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true });

  const ids = [];
  const seen = new Set();
  for (const row of records) {
    const id = (row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ── Transcript helpers ────────────────────────────────────────────────────────

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

// ── Bulk prefetch helpers ─────────────────────────────────────────────────────

async function fetchActiveCallIds(types, scopeCallIds) {
  const rows = await prisma.job.findMany({
    where:  { type: { in: types }, status: { in: ['pending', 'processing'] }, callId: { in: scopeCallIds } },
    select: { callId: true },
  });
  return new Set(rows.map(r => r.callId));
}

async function fetchDoneCallIds(sourceDocType, scopeCallIds) {
  const rows = await prisma.transcriptSignalV2.findMany({
    where:    { is_invalidated: false, source_doc_type: sourceDocType, call_id: { in: scopeCallIds } },
    select:   { call_id: true },
    distinct: ['call_id'],
  });
  return new Set(rows.map(r => r.call_id));
}

// ── Per-call processors ───────────────────────────────────────────────────────

async function processTranscript(call, queuedIds, doneIds) {
  if (!call.transcript_url) return { queued: 0, skipped: 0, noSource: 1, failed: 0 };

  if (queuedIds.has(call.id)) {
    console.log(`    [SKIP] transcript ${call.id} — already in queue`);
    return { queued: 0, skipped: 1, noSource: 0, failed: 0 };
  }

  if (doneIds.has(call.id)) {
    if (!force) return { queued: 0, skipped: 1, noSource: 0, failed: 0 };
    const n = await invalidateV2Signals(call.id);
    doneIds.delete(call.id);
    console.log(`    [FORCE] transcript ${call.id} — invalidated ${n} signals`);
  }

  try {
    const result = await dispatchV2(call.id);
    console.log(`    [OK] transcript ${call.id} ${call.fiscal_year} ${call.quarter} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
    return { queued: result.jobs.length, skipped: 0, noSource: 0, failed: 0 };
  } catch (err) {
    console.log(`    [FAIL] transcript ${call.id} — ${err.message}`);
    return { queued: 0, skipped: 0, noSource: 0, failed: 1 };
  }
}

async function processPpt(call, queuedIds, doneIds) {
  if (!call.ppt_url) return { queued: 0, skipped: 0, noSource: 1, failed: 0 };

  if (queuedIds.has(call.id)) {
    console.log(`    [SKIP] ppt ${call.id} — already in queue`);
    return { queued: 0, skipped: 1, noSource: 0, failed: 0 };
  }

  if (doneIds.has(call.id)) {
    if (!force) return { queued: 0, skipped: 1, noSource: 0, failed: 0 };
    const n = await invalidatePptSignals(call.id);
    doneIds.delete(call.id);
    console.log(`    [FORCE] ppt ${call.id} — invalidated ${n} signals`);
  }

  try {
    const result = await dispatchPpt(call.id);
    console.log(`    [OK] ppt ${call.id} ${call.fiscal_year} ${call.quarter} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
    return { queued: result.jobs.length, skipped: 0, noSource: 0, failed: 0 };
  } catch (err) {
    console.log(`    [FAIL] ppt ${call.id} — ${err.message}`);
    return { queued: 0, skipped: 0, noSource: 0, failed: 1 };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const csvIds = loadCallIdsFromCsv(csvPath);
  console.log(`\nLoaded ${csvIds.length} distinct call ids from ${path.relative(process.cwd(), csvPath)}`);
  console.log(`Mode: ${dispatch ? `dispatch → ${API_URL}` : 'dry-run'}${force ? ' (--force)' : ''}\n`);

  const foundCalls = await prisma.earnings_calls.findMany({
    where:  { id: { in: csvIds } },
    select: { id: true, company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
  });

  const foundById = new Map(foundCalls.map(c => [c.id, c]));
  const missingIds = csvIds.filter(id => !foundById.has(id));

  console.log(`Matched ${foundCalls.length}/${csvIds.length} ids in earnings_calls${missingIds.length ? `, ${missingIds.length} not found` : ''}\n`);
  if (missingIds.length) {
    console.log('Missing ids (not found in earnings_calls, skipped):');
    for (const id of missingIds) console.log(`    ${id}`);
    console.log();
  }

  if (!dispatch) {
    for (const call of foundCalls) {
      console.log(`  ${call.id.padEnd(30)} ${call.company.padEnd(14)} ${call.fiscal_year} ${(call.quarter ?? '').padEnd(4)}  transcript:${call.transcript_url ? 'yes' : 'no'}  ppt:${call.ppt_url ? 'yes' : 'no'}`);
    }
    console.log('\nDry run — pass --dispatch to call the API.\n');
    return;
  }

  const scopeCallIds = foundCalls.map(c => c.id);

  console.log('Prefetching completed signals and active queue...');
  const [txQueuedIds, pptQueuedIds, txDoneIds, pptDoneIds] = await Promise.all([
    fetchActiveCallIds(['summarization_v2'], scopeCallIds),
    fetchActiveCallIds(['summarization_v2_ppt'], scopeCallIds),
    fetchDoneCallIds('transcript', scopeCallIds),
    fetchDoneCallIds('ppt', scopeCallIds),
  ]);
  console.log(`  done — transcript: ${txDoneIds.size}, ppt: ${pptDoneIds.size}`);
  console.log(`  queued — transcript: ${txQueuedIds.size}, ppt: ${pptQueuedIds.size}\n`);

  const totals = { queued: 0, skipped: 0, noSource: 0, failed: 0 };

  for (const call of foundCalls) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${call.id} (${call.company} FY${call.fiscal_year} ${call.quarter})`);
    console.log('─'.repeat(60));

    console.log('  [transcript]');
    const tx = await processTranscript(call, txQueuedIds, txDoneIds);
    console.log(`    → queued=${tx.queued} skipped=${tx.skipped} no-source=${tx.noSource} failed=${tx.failed}`);

    console.log('  [ppt]');
    const pp = await processPpt(call, pptQueuedIds, pptDoneIds);
    console.log(`    → queued=${pp.queued} skipped=${pp.skipped} no-source=${pp.noSource} failed=${pp.failed}`);

    for (const src of [tx, pp]) {
      totals.queued   += src.queued;
      totals.skipped  += src.skipped;
      totals.noSource += src.noSource;
      totals.failed   += src.failed;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  TOTAL  queued=${totals.queued}  skipped=${totals.skipped}  no-source=${totals.noSource}  failed=${totals.failed}  missing-ids=${missingIds.length}`);
  console.log('─'.repeat(60) + '\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
