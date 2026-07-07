'use strict';

/**
 * L1 multi-dispatch — transcript + PPT + annual report extraction for a chosen
 * set of tickers. Ported from scripts/analysis/analyze_L1_v2_multi_all.js so the
 * CLI script, the scheduler's manual-trigger handler, and the admin routes all
 * share one implementation.
 *
 * `options`:
 *   groupSlug  string    — resolve tickers from a saved CompanyGroup; takes precedence over `tickers`/`all`
 *   tickers    string[]  — explicit ticker list (defaults to DEFAULT_TARGET_TICKERS)
 *   all        boolean   — use every distinct company in DB instead of `tickers`
 *   startFrom  string    — skip tickers alphabetically before this one
 *   limit      number    — cap calls/reports processed per ticker
 *   latest     number    — like `limit`, but takes precedence when both are set
 *   force      boolean   — invalidate existing signals and reprocess
 *   arOnly     boolean   — annual reports only, skip transcript/ppt
 *   noAr       boolean   — skip annual reports
 */

const prisma = require('../../config/prisma');
const { DEFAULT_TARGET_TICKERS } = require('./targetTickers');
const { hasSignals, invalidateSignals, fetchActiveCallIds, fetchDoneCallIds } = require('./signalStore');
const { dispatchEndpoint } = require('./apiDispatchClient');
const { resolveGroupBySlug } = require('../companyGroups/groups.service');
const { buildSignalReportCsv } = require('./csvReport');

function resolveEffectiveLimit(options) {
  return options.latest ?? options.limit ?? null;
}

async function resolveTickers(options) {
  let tickers;
  if (options.groupSlug) {
    tickers = await resolveGroupBySlug(options.groupSlug);
  } else if (options.all) {
    tickers = (await prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }))
      .map(r => r.company).filter(Boolean).sort();
  } else {
    tickers = options.tickers?.length ? options.tickers : DEFAULT_TARGET_TICKERS;
  }

  if (options.startFrom) {
    const startFrom = options.startFrom.toUpperCase();
    tickers = tickers.filter(t => t.toUpperCase() >= startFrom);
  }
  return tickers;
}

// ── Per-ticker processors (dispatch mode) ───────────────────────────────────

async function processTranscripts(symbol, queuedIds, doneIds, options) {
  const limit = resolveEffectiveLimit(options);
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, quarter: true, transcript_url: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });
  const calls = limit ? allCalls.slice(0, limit) : allCalls;

  let queued = 0, skipped = 0, noSource = 0, failed = 0;
  for (const c of calls) {
    if (!c.transcript_url) { noSource++; continue; }
    if (queuedIds.has(c.id)) { skipped++; continue; }

    if (doneIds.has(c.id)) {
      if (!options.force) { skipped++; continue; }
      await invalidateSignals(c.id, 'transcript');
      doneIds.delete(c.id);
    }

    try {
      const result = await dispatchEndpoint(`/api/calls/${c.id}/summarize-v2`);
      queued += result.jobs.length;
    } catch (err) {
      console.error(`[l1-multi-dispatch] transcript ${c.id} (${symbol} ${c.fiscal_year} ${c.quarter}): ${err.message}`);
      failed++;
    }
  }
  return { total: calls.length, queued, skipped, noSource, failed };
}

async function processPpts(symbol, queuedIds, doneIds, options) {
  const limit = resolveEffectiveLimit(options);
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, quarter: true, ppt_url: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });
  const calls = limit ? allCalls.slice(0, limit) : allCalls;

  let queued = 0, skipped = 0, noSource = 0, failed = 0;
  for (const c of calls) {
    if (!c.ppt_url) { noSource++; continue; }
    if (queuedIds.has(c.id)) { skipped++; continue; }

    if (doneIds.has(c.id)) {
      if (!options.force) { skipped++; continue; }
      await invalidateSignals(c.id, 'ppt');
      doneIds.delete(c.id);
    }

    try {
      const result = await dispatchEndpoint(`/api/calls/${c.id}/summarize-v2-ppt`);
      queued += result.jobs.length;
    } catch (err) {
      console.error(`[l1-multi-dispatch] ppt ${c.id} (${symbol} ${c.fiscal_year} ${c.quarter}): ${err.message}`);
      failed++;
    }
  }
  return { total: calls.length, queued, skipped, noSource, failed };
}

async function processAnnualReports(symbol, queuedIds, doneIds, options) {
  const limit = resolveEffectiveLimit(options);
  const arLimit = limit ?? 3;
  const allReports = await prisma.annual_reports.findMany({
    where:   { company: symbol },
    select:  { id: true, fiscal_year: true, annual_report_url: true },
    orderBy: { fiscal_year: 'desc' },
  });
  const reports = allReports.slice(0, arLimit);

  let queued = 0, skipped = 0, noSource = 0, failed = 0;
  for (const r of reports) {
    if (!r.annual_report_url) { noSource++; continue; }
    if (queuedIds.has(r.id.toString())) { skipped++; continue; }

    const isDone = doneIds === null ? await hasSignals(r.id, 'annual_report') : doneIds.has(r.id.toString());
    if (isDone) {
      if (!options.force) { skipped++; continue; }
      await invalidateSignals(r.id, 'annual_report');
      if (doneIds !== null) doneIds.delete(r.id.toString());
    }

    try {
      const result = await dispatchEndpoint(`/api/annual-reports/${r.id}/summarize-v2`);
      queued += result.jobs.length;
    } catch (err) {
      console.error(`[l1-multi-dispatch] ar ${r.id} (${symbol} ${r.fiscal_year}): ${err.message}`);
      failed++;
    }
  }
  return { total: reports.length, queued, skipped, noSource, failed };
}

// ── Entry points ─────────────────────────────────────────────────────────────

async function previewL1MultiDispatch(options = {}) {
  const tickers = await resolveTickers(options);
  const limit   = resolveEffectiveLimit(options);
  const arLimit = limit ?? 3;

  // One batched query per source across every ticker (same fix as
  // buildDocumentCoverageReport below), not one round-trip per ticker — the
  // old per-ticker loop scaled linearly with ticker count (13s at 63
  // tickers, 65s at 300, ~7min+ extrapolated at "all") because each of the
  // ~2000 companies paid its own DB round-trip latency in sequence.
  const [calls, reports] = await Promise.all([
    options.arOnly ? Promise.resolve([]) : prisma.earnings_calls.findMany({
      where:   { company: { in: tickers } },
      select:  { id: true, company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    }),
    prisma.annual_reports.findMany({
      where:   { company: { in: tickers } },
      select:  { id: true, company: true, fiscal_year: true, annual_report_url: true },
      orderBy: { fiscal_year: 'desc' },
    }),
  ]);

  // Partition the globally-ordered result sets back out per company. This
  // preserves each company's own descending fiscal_year/quarter order without
  // a separate per-company sort: the global ORDER BY already guarantees every
  // FY2026-Q4 row (across all companies) precedes every FY2026-Q3 row, so a
  // single company's own subsequence stays correctly ordered as we partition.
  const callsByCompany = new Map(tickers.map(t => [t, []]));
  for (const c of calls) callsByCompany.get(c.company)?.push(c);
  const reportsByCompany = new Map(tickers.map(t => [t, []]));
  for (const r of reports) reportsByCompany.get(r.company)?.push(r);

  const perTickerRaw = tickers.map(symbol => {
    const tCalls   = callsByCompany.get(symbol) ?? [];
    const tReports = reportsByCompany.get(symbol) ?? [];
    const shownCalls   = limit ? tCalls.slice(0, limit) : tCalls;
    const shownReports = tReports.slice(0, arLimit);
    return { symbol, calls: tCalls, reports: tReports, shownCalls, shownReports };
  });

  // Batch signal-status lookups, scoped to just the shown items across every
  // ticker — avoids the unscoped-full-table-scan timeout (see
  // services/companyGroups/resolver.js's docTypeFilterSet for the same fix).
  const shownCallIds   = perTickerRaw.flatMap(t => t.shownCalls.map(c => c.id));
  const shownReportIds = perTickerRaw.flatMap(t => t.shownReports.map(r => r.id.toString()));

  const [transcriptSignalIds, pptSignalIds, arSignalIds] = await Promise.all([
    fetchDoneCallIds('transcript', shownCallIds),
    fetchDoneCallIds('ppt', shownCallIds),
    fetchDoneCallIds('annual_report', shownReportIds),
  ]);

  const perTicker = perTickerRaw.map(({ symbol, calls, reports, shownCalls, shownReports }) => ({
    symbol,
    calls: {
      shown: shownCalls.length,
      total: calls.length,
      items: shownCalls.map(c => ({
        id: c.id, fiscal_year: c.fiscal_year, quarter: c.quarter,
        hasTranscript: !!c.transcript_url, hasPpt: !!c.ppt_url,
        hasTranscriptSignal: transcriptSignalIds.has(c.id),
        hasPptSignal:        pptSignalIds.has(c.id),
      })),
    },
    annualReports: {
      shown: shownReports.length,
      total: reports.length,
      items: shownReports.map(r => ({
        id: r.id.toString(), fiscal_year: r.fiscal_year, hasUrl: !!r.annual_report_url,
        hasSignal: arSignalIds.has(r.id.toString()),
      })),
    },
  }));

  return { tickerCount: tickers.length, tickers, perTicker };
}

// Column groups for the CSV: document presence (has a URL) AND whether L1
// extraction has already happened for that document — the same two facts
// previewL1MultiDispatch's hasTranscript/hasPpt vs hasTranscriptSignal/
// hasPptSignal/hasSignal pairs show in the JSON preview, just also surfaced
// in the CSV rather than only the JSON one.
const L1_CSV_GROUPS = [
  { key: 'transcript',           kind: 'quarterly' },
  { key: 'transcript_signal',    kind: 'quarterly' },
  { key: 'ppt',                  kind: 'quarterly' },
  { key: 'ppt_signal',           kind: 'quarterly' },
  { key: 'annual_report',        kind: 'yearly' },
  { key: 'annual_report_signal', kind: 'yearly' },
];

// Full, uncapped document-coverage report for CSV export — deliberately
// ignores limit/latest/arOnly/noAr (those are run-time caps, not relevant to
// "how much history does this company have"; note previewL1MultiDispatch
// itself always caps annual reports to 3 by default via `arLimit = limit ?? 3`,
// so it can't be reused as-is for a full report). One batched query per
// source across the whole ticker set, not per-ticker (both for documents and
// for signal-done status, via fetchDoneCallIds scoped to just these calls/
// reports — same pattern previewL1MultiDispatch itself uses to avoid an
// unscoped full-table scan). Presence becomes a count of 1 per period,
// matching the shape services/pipelineDispatch/csvReport.js expects.
async function buildDocumentCoverageReport(tickers) {
  const [calls, reports] = await Promise.all([
    prisma.earnings_calls.findMany({
      where:  { company: { in: tickers } },
      select: { id: true, company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
    }),
    prisma.annual_reports.findMany({
      where:  { company: { in: tickers } },
      select: { id: true, company: true, fiscal_year: true, annual_report_url: true },
    }),
  ]);

  const callIds   = calls.map(c => c.id);
  const reportIds = reports.map(r => r.id.toString());

  const [transcriptSignalIds, pptSignalIds, arSignalIds] = await Promise.all([
    fetchDoneCallIds('transcript', callIds),
    fetchDoneCallIds('ppt', callIds),
    fetchDoneCallIds('annual_report', reportIds),
  ]);

  const byTicker = new Map(tickers.map(t => [t, {
    transcript: [], transcript_signal: [],
    ppt: [], ppt_signal: [],
    annual_report: [], annual_report_signal: [],
  }]));

  for (const c of calls) {
    const bucket = byTicker.get(c.company);
    if (!bucket) continue;
    if (c.transcript_url) bucket.transcript.push({ fiscal_year: c.fiscal_year, quarter: c.quarter, count: 1 });
    if (c.ppt_url)        bucket.ppt.push({ fiscal_year: c.fiscal_year, quarter: c.quarter, count: 1 });
    if (transcriptSignalIds.has(c.id)) bucket.transcript_signal.push({ fiscal_year: c.fiscal_year, quarter: c.quarter, count: 1 });
    if (pptSignalIds.has(c.id))        bucket.ppt_signal.push({ fiscal_year: c.fiscal_year, quarter: c.quarter, count: 1 });
  }
  for (const r of reports) {
    const bucket = byTicker.get(r.company);
    if (!bucket) continue;
    if (r.annual_report_url) bucket.annual_report.push({ fiscal_year: r.fiscal_year, count: 1 });
    if (arSignalIds.has(r.id.toString())) bucket.annual_report_signal.push({ fiscal_year: r.fiscal_year, count: 1 });
  }

  return tickers.map(ticker => {
    const b = byTicker.get(ticker);
    const toEntry = list => ({ total: list.length, periods: list });
    return {
      ticker,
      transcript:           toEntry(b.transcript),
      transcript_signal:    toEntry(b.transcript_signal),
      ppt:                  toEntry(b.ppt),
      ppt_signal:           toEntry(b.ppt_signal),
      annual_report:        toEntry(b.annual_report),
      annual_report_signal: toEntry(b.annual_report_signal),
    };
  });
}

async function previewL1MultiDispatchCsv(options = {}) {
  const tickers = await resolveTickers(options);
  const perTicker = await buildDocumentCoverageReport(tickers);
  return buildSignalReportCsv(perTicker, L1_CSV_GROUPS);
}

async function runL1MultiDispatch(options = {}) {
  const tickers = await resolveTickers(options);
  console.log(`[l1-multi-dispatch] tickers=${tickers.length} force=${!!options.force} arOnly=${!!options.arOnly} noAr=${!!options.noAr}`);

  let scopeCallIds = null;
  if (!options.all) {
    const scopeCallRows = await prisma.earnings_calls.findMany({
      where:  { company: { in: tickers } },
      select: { id: true },
    });
    scopeCallIds = scopeCallRows.map(r => r.id);
  }

  const [txQueuedIds, pptQueuedIds, arQueuedIds, txDoneIds, pptDoneIds, arDoneIds] = await Promise.all([
    options.arOnly ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2'], scopeCallIds),
    options.arOnly ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2_ppt'], scopeCallIds),
    options.noAr   ? Promise.resolve(new Set()) : fetchActiveCallIds(['summarization_v2_annual_report'], scopeCallIds),
    options.arOnly ? Promise.resolve(new Set()) : fetchDoneCallIds('transcript', scopeCallIds),
    options.arOnly ? Promise.resolve(new Set()) : fetchDoneCallIds('ppt', scopeCallIds),
    options.noAr   ? Promise.resolve(new Set()) : (scopeCallIds === null ? Promise.resolve(null) : fetchDoneCallIds('annual_report', scopeCallIds)),
  ]);

  const totals = { queued: 0, skipped: 0, noSource: 0, failed: 0 };
  const perTicker = [];

  for (const symbol of tickers) {
    const srcs = [];

    if (!options.arOnly) {
      const tx = await processTranscripts(symbol, txQueuedIds, txDoneIds, options);
      const pp = await processPpts(symbol, pptQueuedIds, pptDoneIds, options);
      srcs.push(tx, pp);
    }
    if (!options.noAr) {
      const ar = await processAnnualReports(symbol, arQueuedIds, arDoneIds, options);
      srcs.push(ar);
    }

    const tickerTotals = srcs.reduce((acc, s) => ({
      queued:   acc.queued   + s.queued,
      skipped:  acc.skipped  + s.skipped,
      noSource: acc.noSource + s.noSource,
      failed:   acc.failed   + s.failed,
    }), { queued: 0, skipped: 0, noSource: 0, failed: 0 });

    perTicker.push({ symbol, ...tickerTotals });
    totals.queued   += tickerTotals.queued;
    totals.skipped  += tickerTotals.skipped;
    totals.noSource += tickerTotals.noSource;
    totals.failed   += tickerTotals.failed;
  }

  console.log(`[l1-multi-dispatch] done — queued=${totals.queued} skipped=${totals.skipped} noSource=${totals.noSource} failed=${totals.failed}`);
  return { records_processed: totals.queued, ...totals, tickerCount: tickers.length, perTicker };
}

module.exports = { previewL1MultiDispatch, previewL1MultiDispatchCsv, runL1MultiDispatch, resolveTickers, resolveEffectiveLimit };
