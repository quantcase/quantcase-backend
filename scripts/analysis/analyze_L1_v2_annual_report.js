#!/usr/bin/env node
'use strict';

/**
 * Dispatch v2 annual report signal extraction for all annual reports of a given symbol.
 * Calls POST /api/annual-reports/:reportId/summarize-v2 for each report that has an
 * annual_report_url and no existing v2 annual report signals.
 *
 * Usage:
 *   node scripts/analysis/analyze_L1_v2_annual_report.js <SYMBOL> [--dispatch] [--limit <n>] [--force]
 *
 * Flags:
 *   --dispatch        Actually call the API (dry-run without this flag)
 *   --limit <n>       Only process the n most recent reports (default: all)
 *   --force           Invalidate existing annual report signals and reprocess
 *
 * Env:
 *   API_URL           Base URL of the API server (default: http://localhost:8000)
 *
 * Example (dry-run):
 *   node scripts/analysis/analyze_L1_v2_annual_report.js RELIANCE
 *
 * Example (dispatch 2 most recent):
 *   node scripts/analysis/analyze_L1_v2_annual_report.js RELIANCE --dispatch --limit 2
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const API_URL = process.env.API_URL || 'http://localhost:8000';

const args     = process.argv.slice(2);
const symbol   = args[0];
const dispatch = args.includes('--dispatch');
const force    = args.includes('--force');
const limIdx   = args.indexOf('--limit');
const limit    = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : null;

if (!symbol) {
  console.error('Usage: node scripts/analysis/analyze_L1_v2_annual_report.js <SYMBOL> [--dispatch] [--limit <n>] [--force]');
  process.exit(1);
}

// Annual report signals are identified by source_context values unique to the
// annual report extraction flow (none of these appear in transcript or PPT flows).
const AR_SOURCE_CONTEXTS = [
  'chairman_letter', 'ceo_letter', 'board_report', 'mda',
  'financial_statements', 'notes_to_accounts', 'risk_section', 'governance_section',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasArSignals(reportId) {
  const count = await prisma.transcriptSignalV2.count({
    where: {
      call_id:        reportId.toString(),
      is_invalidated: false,
      source_context: { in: AR_SOURCE_CONTEXTS },
    },
  });
  return count > 0;
}

async function invalidateArSignals(reportId) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: {
      call_id:        reportId.toString(),
      is_invalidated: false,
      source_context: { in: AR_SOURCE_CONTEXTS },
    },
    data: { is_invalidated: true },
  });
  return result.count;
}

async function dispatchAr(reportId) {
  const res  = await fetch(`${API_URL}/api/annual-reports/${reportId}/summarize-v2`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function main() {
  const allReports = await prisma.annual_reports.findMany({
    where:   { company: symbol },
    select:  { id: true, company: true, fiscal_year: true, call_date: true, annual_report_url: true },
    orderBy: { fiscal_year: 'desc' },
  });

  if (allReports.length === 0) {
    console.log(`No annual reports found for symbol: ${symbol}`);
    return;
  }

  const reports = limit ? allReports.slice(0, limit) : allReports;

  console.log(`\nAnnual reports for ${symbol} — ${reports.length} of ${allReports.length} total${limit ? ` (limited to ${limit})` : ''}\n`);
  console.log('ID'.padEnd(10), 'FY'.padEnd(12), 'Call Date'.padEnd(22), 'URL');
  console.log('-'.repeat(100));

  for (const r of reports) {
    console.log(
      r.id.toString().padEnd(10),
      (r.fiscal_year ?? '').padEnd(12),
      (r.call_date ?? '').padEnd(22),
      r.annual_report_url ? r.annual_report_url.slice(0, 60) + '…' : 'none',
    );
  }
  console.log();

  if (!dispatch) {
    console.log('Dry run — pass --dispatch to call the API.\n');
    return;
  }

  console.log(`Dispatching to ${API_URL}...\n`);
  let queued = 0, skipped = 0, noSource = 0, failed = 0;

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];

    if (!r.annual_report_url) {
      console.log(`  [SKIP] ${r.id}  — no annual_report_url`);
      noSource++;
      continue;
    }

    const already = await hasArSignals(r.id);
    if (already) {
      if (!force) {
        console.log(`  [SKIP] ${r.id}  — signals already exist (use --force to reprocess)`);
        skipped++;
        continue;
      }
      const invalidated = await invalidateArSignals(r.id);
      console.log(`  [FORCE] ${r.id}  — invalidated ${invalidated} existing signals`);
    }

    try {
      const result = await dispatchAr(r.id);
      console.log(`  [OK]   ${r.id}  ${r.fiscal_year}  — ${result.pageCount}pp → ${result.chunks} chunks, jobs: ${result.jobs.map(j => j.id).join(', ')}`);
      queued += result.jobs.length;
    } catch (err) {
      console.log(`  [FAIL] ${r.id}  — ${err.message}`);
      failed++;
    }

    if (i < reports.length - 1) await sleep(300);
  }

  console.log(`\nDone. queued=${queued} jobs  skipped=${skipped}  no-source=${noSource}  failed=${failed}\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
