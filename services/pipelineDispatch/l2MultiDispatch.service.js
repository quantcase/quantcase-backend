'use strict';

/**
 * L2 multi-dispatch — html-incremental-skill runs (see
 * services/htmlIncrementalSkill.service.js) for a chosen set of tickers
 * against one skill. Deliberately simpler than L1 multi-dispatch: one run
 * per ticker (its latest earnings_calls period), not per-document. configKey
 * is never passed here — each run resolves its own config from the ticker's
 * CompanyGroup.config_key at processing time (see resolveRequiredConfigKey
 * in htmlIncrementalSkill.service.js); a ticker with no resolvable config
 * fails that one run rather than blocking the batch.
 *
 * Preview is a signal-availability report (total + per-period counts for
 * transcript/ppt/annual_report), not a per-ticker prompt dry-run — building
 * a full prompt per ticker doesn't make sense once a batch is 100+ companies.
 * `historic` isn't relevant to preview because of this — it's only used by
 * the real run.
 *
 * `options`:
 *   slug       string    — HtmlIncrementalSkill slug (required) — signal counts are filtered to this skill's own signal-type whitelist
 *   groupSlug  string    — resolve tickers from a saved CompanyGroup; takes precedence over `tickers`/`all`
 *   tickers    string[]  — explicit ticker list
 *   all        boolean   — every distinct company in earnings_calls
 *   startFrom  string    — skip tickers alphabetically before this one
 *   historic   boolean   — historic vs incremental mode (default false) — run only
 *   force      boolean   — bypass the prompt-version cache — run only
 */

const prisma = require('../../config/prisma');
const { resolveGroupBySlug } = require('../companyGroups');
const { dispatchEndpoint } = require('./apiDispatchClient');
const { periodRank, buildSignalReportCsv } = require('./csvReport');

async function resolveTickers(options) {
  let tickers;
  if (options.groupSlug) {
    tickers = await resolveGroupBySlug(options.groupSlug);
  } else if (options.all) {
    tickers = (await prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }))
      .map(r => r.company).filter(Boolean).sort();
  } else {
    tickers = options.tickers?.length ? options.tickers : [];
  }

  if (options.startFrom) {
    const startFrom = options.startFrom.toUpperCase();
    tickers = tickers.filter(t => t.toUpperCase() >= startFrom);
  }
  return tickers;
}

// One job per ticker — its latest reporting period, by (fiscal_year, quarter).
async function resolveLatestCall(ticker) {
  return prisma.earnings_calls.findFirst({
    where:   { company: ticker },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    select:  { id: true, fiscal_year: true, quarter: true },
  });
}

// Batched signal-availability report — one DB query for every ticker in the
// set (not one per ticker), grouped into per-source, per-period counts. This
// is what /preview returns instead of building a full prompt per ticker:
// at 200-company scale, "what would the prompt look like" doesn't make
// sense, but "how much of each document type does each company have" does —
// it's what actually informs which config (t1/t2/t3) or company group a
// ticker belongs in. Filtered to the skill's own signal-type whitelist, same
// as the single-ticker /signals/count/:ticker endpoint, so the counts mean
// "signals this skill would actually use," not a fully generic raw count.
async function buildSignalAvailabilityReport(slug, tickers) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({
    where:  { slug },
    select: { transcript_signal_types: true, ppt_signal_types: true, annual_report_signal_types: true },
  });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });

  const allTypes = [...skill.transcript_signal_types, ...skill.ppt_signal_types, ...skill.annual_report_signal_types];

  // Aggregated server-side (GROUP BY) instead of fetching every matching
  // signal row into Node and counting them in a JS Map — for a broad
  // signal-type whitelist run against `all` companies, this table can match
  // close to its entire multi-million-row size, and pulling that many raw
  // rows into the API process risks OOMing it. This still has to scan the
  // same rows, but only ~(tickers x doc types x periods) rows now cross the
  // wire instead of every individual signal row.
  const groups = allTypes.length
    ? await prisma.$queryRaw`
        SELECT ticker, source_doc_type, fiscal_year, quarter, count(*)::int AS cnt
        FROM transcript_signals_v2
        WHERE is_invalidated = false
          AND ticker = ANY(${tickers}::text[])
          AND signal_type = ANY(${allTypes}::text[])
        GROUP BY ticker, source_doc_type, fiscal_year, quarter
      `
    : await prisma.$queryRaw`
        SELECT ticker, source_doc_type, fiscal_year, quarter, count(*)::int AS cnt
        FROM transcript_signals_v2
        WHERE is_invalidated = false
          AND ticker = ANY(${tickers}::text[])
        GROUP BY ticker, source_doc_type, fiscal_year, quarter
      `;

  const byTicker = new Map(tickers.map(t => [t, {
    transcript:    new Map(),
    ppt:           new Map(),
    annual_report: new Map(),
  }]));

  for (const r of groups) {
    const bucket = byTicker.get(r.ticker);
    if (!bucket) continue;
    const docType = r.source_doc_type === 'annual_report' ? 'annual_report' : r.source_doc_type === 'ppt' ? 'ppt' : 'transcript';
    const key = docType === 'annual_report' ? r.fiscal_year : `${r.fiscal_year}|${r.quarter}`;
    const m = bucket[docType];
    m.set(key, (m.get(key) ?? 0) + r.cnt);
  }

  const toQtrPeriods = m => [...m.entries()]
    .map(([k, count]) => { const [fiscal_year, quarter] = k.split('|'); return { fiscal_year, quarter, count }; })
    .sort((a, b) => periodRank(b.fiscal_year, b.quarter) - periodRank(a.fiscal_year, a.quarter));

  const toYearPeriods = m => [...m.entries()]
    .map(([fiscal_year, count]) => ({ fiscal_year, count }))
    .sort((a, b) => periodRank(b.fiscal_year, null) - periodRank(a.fiscal_year, null));

  const perTicker = tickers.map(ticker => {
    const b = byTicker.get(ticker);
    const transcript    = toQtrPeriods(b.transcript);
    const ppt           = toQtrPeriods(b.ppt);
    const annual_report = toYearPeriods(b.annual_report);
    return {
      ticker,
      transcript:    { total: transcript.reduce((s, r) => s + r.count, 0),    periods: transcript },
      ppt:           { total: ppt.reduce((s, r) => s + r.count, 0),           periods: ppt },
      annual_report: { total: annual_report.reduce((s, r) => s + r.count, 0), periods: annual_report },
    };
  });

  return perTicker;
}

// Dry run — no jobs enqueued, no LLM calls, no per-ticker prompt assembly.
// Sorting is deliberately left to the frontend (it has the full totals per
// source already, e.g. sort ascending by (transcript.total + ppt.total +
// annual_report.total) to surface least-covered/"most critical" companies
// first) rather than baking one sort order into the API.
async function previewL2MultiDispatch(options = {}) {
  const { slug } = options;
  const tickers = await resolveTickers(options);
  const perTicker = await buildSignalAvailabilityReport(slug, tickers);
  return { slug, tickerCount: tickers.length, perTicker };
}

// CSV export of the same report — see services/pipelineDispatch/csvReport.js
// for the flattened-column format (shared with L1's coverage-report CSV).
async function previewL2MultiDispatchCsv(options = {}) {
  const { slug } = options;
  const tickers = await resolveTickers(options);
  const perTicker = await buildSignalAvailabilityReport(slug, tickers);
  return buildSignalReportCsv(perTicker);
}

// Real dispatch — one POST per ticker to the actual, tried-and-tested
// POST /api/html-incremental-skills/:slug/run endpoint (same pattern as L1's
// dispatchEndpoint calls) rather than calling addHtmlIncrementalSkillJob
// in-process. This means every validation the route does (ticker/callId
// presence, skill exists, skill is_active) automatically applies to batch
// runs too, with no separate code path to keep in sync — a bad slug or an
// inactive skill now fails fast per-ticker here instead of silently queuing
// a job that would only fail later inside the worker. configKey is still
// never sent; each run resolves its own config from the ticker's
// CompanyGroup.config_key when the worker processes it (see
// resolveRequiredConfigKey) — response shape below is unchanged from before.
async function runL2MultiDispatch(options = {}) {
  const { slug, historic = false, force = false } = options;
  const tickers = await resolveTickers(options);
  console.log(`[l2-multi-dispatch] slug=${slug} tickers=${tickers.length} historic=${!!historic} force=${!!force}`);

  const totals = { queued: 0, noSource: 0, failed: 0 };
  const perTicker = [];

  for (const ticker of tickers) {
    const call = await resolveLatestCall(ticker);
    if (!call) {
      totals.noSource++;
      perTicker.push({ ticker, status: 'noSource' });
      continue;
    }
    try {
      const result = await dispatchEndpoint(`/api/html-incremental-skills/${slug}/run`, {
        body: { ticker, callId: call.id, historic, force },
      });
      totals.queued++;
      perTicker.push({ ticker, status: 'queued', callId: call.id, jobId: result.job?.id ?? null });
    } catch (err) {
      console.error(`[l2-multi-dispatch] ${ticker} (${call.id}): ${err.message}`);
      totals.failed++;
      perTicker.push({ ticker, status: 'failed', callId: call.id, error: err.message });
    }
  }

  console.log(`[l2-multi-dispatch] done — queued=${totals.queued} noSource=${totals.noSource} failed=${totals.failed}`);
  return { records_processed: totals.queued, ...totals, tickerCount: tickers.length, perTicker };
}

module.exports = { previewL2MultiDispatch, previewL2MultiDispatchCsv, runL2MultiDispatch, resolveTickers, resolveLatestCall };
