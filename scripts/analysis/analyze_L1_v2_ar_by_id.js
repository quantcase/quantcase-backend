#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 L1 extraction for a fixed list of annual_reports document IDs.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_ar_by_id.js [--dispatch] [--force]
 *
 * Flags:
 *   --dispatch        Actually call the API (dry-run without this flag)
 *   --force           Invalidate existing signals and reprocess
 *
 * Env:
 *   API_URL           Base URL of the API server (default: http://localhost:8000)
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const TARGET_IDS = [
  57698, 57697, 57696, 57695, 57694, 57693, 57692, 57691, 57690, 57689,
  57688, 57687, 57686, 57685, 57684, 57683, 57682, 57681, 57680, 57679,
  57678, 57677, 57676, 57675, 57674, 57673, 57672, 57671, 57670, 57669,
  57668, 57667, 57666, 57665, 57664, 57663, 57662, 57661, 57660, 57659,
  57658, 57657, 57656, 57655, 57654, 57653, 57652, 57651, 57650, 57649,
  57648, 57647, 57646, 57645, 57644, 57643, 57642, 57641, 57640, 57639,
  57638, 57637, 57636, 57635, 57634, 57633, 57632, 57631, 57630, 57629,
  57628, 57627, 57626, 57625, 57624, 57623, 57622, 57621, 57620, 57619,
  57618, 57617, 57616, 57615, 57614, 57613, 57612, 57611, 57610, 57609,
  57608, 57607, 57606, 57605, 57604, 57603, 57602, 57601, 57600, 57599,
  57598, 57597, 57596, 57595, 57594, 57593, 57592, 57591, 57590, 57589,
  57588, 57587, 57586, 57585, 57584, 57583, 57581, 57580, 57579, 57578,
  57577, 57576, 57575, 57574, 57573, 57572,
];

const API_URL = process.env.API_URL || 'http://localhost:8000';

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const force    = args.includes('--force');

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

async function fetchActiveReportIds(ids) {
  const rows = await prisma.job.findMany({
    where:  { type: { in: ['summarization_v2_annual_report'] }, status: { in: ['pending', 'processing'] }, callId: { in: ids.map(String) } },
    select: { callId: true },
  });
  return new Set(rows.map(r => r.callId));
}

async function fetchDoneReportIds(ids) {
  const rows = await prisma.transcriptSignalV2.findMany({
    where:    { is_invalidated: false, source_doc_type: 'annual_report', call_id: { in: ids.map(String) } },
    select:   { call_id: true },
    distinct: ['call_id'],
  });
  return new Set(rows.map(r => r.call_id));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTarget annual report IDs (${TARGET_IDS.length})`);
  console.log(`Mode: ${dispatch ? `dispatch → ${API_URL}` : 'dry-run'}${force ? ' (--force)' : ''}\n`);

  const reports = await prisma.annual_reports.findMany({
    where:   { id: { in: TARGET_IDS } },
    select:  { id: true, company: true, fiscal_year: true, annual_report_url: true },
    orderBy: { id: 'desc' },
  });

  const foundIds = new Set(reports.map(r => r.id));
  const missingIds = TARGET_IDS.filter(id => !foundIds.has(id));

  if (!dispatch) {
    for (const r of reports) {
      console.log(`  id:${r.id.toString().padEnd(8)} ${(r.company ?? '').padEnd(15)} FY${r.fiscal_year}  url:${r.annual_report_url ? 'yes' : 'no'}`);
    }
    if (missingIds.length) {
      console.log(`\n  Missing from annual_reports table (${missingIds.length}): ${missingIds.join(', ')}`);
    }
    console.log('\nDry run — pass --dispatch to call the API.\n');
    return;
  }

  if (missingIds.length) {
    console.log(`  [WARN] not found in annual_reports table (${missingIds.length}): ${missingIds.join(', ')}\n`);
  }

  console.log('Prefetching completed signals and active queue...');
  const [queuedIds, doneIds] = await Promise.all([
    fetchActiveReportIds(TARGET_IDS),
    fetchDoneReportIds(TARGET_IDS),
  ]);
  console.log(`  done: ${doneIds.size}, queued: ${queuedIds.size}\n`);

  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (const r of reports) {
    const idStr = r.id.toString();
    if (!r.annual_report_url) {
      console.log(`  [SKIP] ar ${r.id} — no source URL`);
      noSource++; continue;
    }

    if (queuedIds.has(idStr)) {
      console.log(`  [SKIP] ar ${r.id} — already in queue`);
      skipped++; continue;
    }

    let isDone = doneIds.has(idStr);
    if (isDone) {
      if (!force) {
        console.log(`  [SKIP] ar ${r.id} — already has signals`);
        skipped++; continue;
      }
      const n = await invalidateArSignals(r.id);
      console.log(`  [FORCE] ar ${r.id} — invalidated ${n} signals`);
    }

    try {
      const result = await dispatchAr(r.id);
      console.log(`  [OK] ar ${r.id} ${r.company} FY${r.fiscal_year} — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`  [FAIL] ar ${r.id} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  TOTAL  queued=${queued}  skipped=${skipped}  no-source=${noSource}  failed=${failed}  missing=${missingIds.length}`);
  console.log('─'.repeat(60) + '\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
