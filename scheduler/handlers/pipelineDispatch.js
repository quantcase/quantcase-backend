'use strict';

/**
 * Pipeline dispatch handler — finds unprocessed documents and triggers L1 analysis.
 *
 * Logic mirrors scripts/analysis/analyze_L1_v2_multi_all.js:
 *   - For each earnings_call with a URL: check transcript_signals_v2 for existing signals
 *   - If none found (and not force): call the summarize-v2 endpoint to enqueue L1 chunks
 *   - Supports transcript, ppt, and annual_report source types
 */

const prisma  = require('../../config/prisma');

const API_URL = process.env.API_URL || 'http://localhost:8000';

async function hasSignals(callId, docType) {
  const count = await prisma.transcriptSignalV2.count({
    where: { call_id: String(callId), is_invalidated: false, source_doc_type: docType },
  });
  return count > 0;
}

async function dispatchEndpoint(url) {
  const res  = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function processTranscripts(limit, force) {
  const calls = await prisma.earnings_calls.findMany({
    where:   { transcript_url: { not: null } },
    select:  { id: true, company: true, fiscal_year: true, quarter: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    ...(limit ? { take: limit } : {}),
  });

  let queued = 0, skipped = 0, failed = 0;
  for (const c of calls) {
    const already = await hasSignals(c.id, 'transcript');
    if (already && !force) { skipped++; continue; }

    try {
      await dispatchEndpoint(`${API_URL}/api/calls/${c.id}/summarize-v2`);
      queued++;
    } catch (err) {
      console.error(`[pipeline-dispatch] transcript ${c.id} (${c.company} ${c.fiscal_year} ${c.quarter}): ${err.message}`);
      failed++;
    }
  }
  return { queued, skipped, failed };
}

async function processPpts(limit, force) {
  const calls = await prisma.earnings_calls.findMany({
    where:   { ppt_url: { not: null } },
    select:  { id: true, company: true, fiscal_year: true, quarter: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    ...(limit ? { take: limit } : {}),
  });

  let queued = 0, skipped = 0, failed = 0;
  for (const c of calls) {
    const already = await hasSignals(c.id, 'ppt');
    if (already && !force) { skipped++; continue; }

    try {
      await dispatchEndpoint(`${API_URL}/api/calls/${c.id}/summarize-v2-ppt`);
      queued++;
    } catch (err) {
      console.error(`[pipeline-dispatch] ppt ${c.id} (${c.company} ${c.fiscal_year} ${c.quarter}): ${err.message}`);
      failed++;
    }
  }
  return { queued, skipped, failed };
}

async function processAnnualReports(limit, force) {
  const reports = await prisma.annual_reports.findMany({
    where:   { annual_report_url: { not: null } },
    select:  { id: true, company: true, fiscal_year: true },
    orderBy: { fiscal_year: 'desc' },
    ...(limit ? { take: limit } : {}),
  });

  let queued = 0, skipped = 0, failed = 0;
  for (const r of reports) {
    const already = await hasSignals(r.id, 'annual_report');
    if (already && !force) { skipped++; continue; }

    try {
      await dispatchEndpoint(`${API_URL}/api/annual-reports/${r.id}/summarize-v2`);
      queued++;
    } catch (err) {
      console.error(`[pipeline-dispatch] annual_report ${r.id} (${r.company} ${r.fiscal_year}): ${err.message}`);
      failed++;
    }
  }
  return { queued, skipped, failed };
}

async function run(config = {}) {
  const sources = config.sources ?? ['transcript', 'ppt', 'annual_report'];
  const limit   = config.limit   ?? null;
  const force   = config.force   ?? false;

  console.log(`[pipeline-dispatch] sources=${sources.join(',')} limit=${limit ?? 'all'} force=${force}`);

  const totals = { queued: 0, skipped: 0, failed: 0 };

  if (sources.includes('transcript')) {
    const r = await processTranscripts(limit, force);
    console.log(`[pipeline-dispatch] transcripts → queued=${r.queued} skipped=${r.skipped} failed=${r.failed}`);
    totals.queued  += r.queued;
    totals.skipped += r.skipped;
    totals.failed  += r.failed;
  }

  if (sources.includes('ppt')) {
    const r = await processPpts(limit, force);
    console.log(`[pipeline-dispatch] ppts → queued=${r.queued} skipped=${r.skipped} failed=${r.failed}`);
    totals.queued  += r.queued;
    totals.skipped += r.skipped;
    totals.failed  += r.failed;
  }

  if (sources.includes('annual_report')) {
    const r = await processAnnualReports(limit, force);
    console.log(`[pipeline-dispatch] annual_reports → queued=${r.queued} skipped=${r.skipped} failed=${r.failed}`);
    totals.queued  += r.queued;
    totals.skipped += r.skipped;
    totals.failed  += r.failed;
  }

  return { records_processed: totals.queued, ...totals };
}

module.exports = { run };
