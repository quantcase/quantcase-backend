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

  const perTicker = [];
  for (const symbol of tickers) {
    const [calls, reports] = await Promise.all([
      options.arOnly ? Promise.resolve([]) : prisma.earnings_calls.findMany({
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

    const shownCalls   = limit ? calls.slice(0, limit) : calls;
    const shownReports = reports.slice(0, arLimit);

    perTicker.push({
      symbol,
      calls: {
        shown: shownCalls.length,
        total: calls.length,
        items: shownCalls.map(c => ({
          id: c.id, fiscal_year: c.fiscal_year, quarter: c.quarter,
          hasTranscript: !!c.transcript_url, hasPpt: !!c.ppt_url,
        })),
      },
      annualReports: {
        shown: shownReports.length,
        total: reports.length,
        items: shownReports.map(r => ({ id: r.id.toString(), fiscal_year: r.fiscal_year, hasUrl: !!r.annual_report_url })),
      },
    });
  }

  return { tickerCount: tickers.length, tickers, perTicker };
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

module.exports = { previewL1MultiDispatch, runL1MultiDispatch, resolveTickers, resolveEffectiveLimit };
