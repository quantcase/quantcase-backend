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
 *   page, pageSize  number — preview only; paginates the resolved ticker list
 *     (default pageSize 100, max 500) so a large groupSlug/`all` preview
 *     doesn't pull every ticker's signal counts into one response. Ignored by
 *     run (which always dispatches to the full resolved set) and by the CSV
 *     export (a full, uncapped dump by design — see below).
 *
 * CSV export (`/preview/csv`) is batched by ticker (SIGNAL_REPORT_TICKER_BATCH_SIZE,
 * same as the query in buildSignalAvailabilityReport) so no single query
 * risks Postgres's statement_timeout, and additionally skips the
 * signal_type whitelist filter entirely (unlike the JSON preview, which
 * always filters to the skill's own whitelist). `signal_type` isn't indexed,
 * so filtering on it forces a heap visit per candidate row and stops
 * Postgres from using the covering ticker/is_invalidated index — measured
 * ~66s vs ~21s for the same 586-ticker (tier2) request, filtered vs
 * unfiltered. This means the CSV reports *total* signal coverage per period,
 * not "signals this skill would use" — a real semantic difference for a
 * narrow-whitelist skill, accepted as the tradeoff for the CSV to stay fast.
 * The JSON preview is unaffected and keeps the accurate, skill-filtered
 * counts (it's already fast via ticker pagination, so it didn't need this).
 */

const prisma = require('../../config/prisma');
const { resolveGroupBySlug } = require('../companyGroups');
const { dispatchEndpoint } = require('./apiDispatchClient');
const { periodRank, writeSignalReportCsv } = require('./csvReport');
const { paginateTickers, chunk } = require('./paginate');
const { TtlCache, cacheKey } = require('./cache');

const cache = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 60_000;   // JSON preview — already fast via pagination, mainly absorbs rapid repeat clicks
const CSV_CACHE_TTL_MS     = 180_000;  // CSV — the actually expensive path (~20-35s for a large group), worth caching longer

// transcript_signals_v2 is ~11.7M rows; a broad signal-type whitelist (near-
// total selectivity) run against a large ticker set scans a lot of it even
// with the ticker/is_invalidated index (tsv2_ticker_invalidated_doctype_period)
// in place — measured ~90s for 586 tickers in one query post-index. Batching
// bounds each individual query's cost so no single one risks the DB's
// statement_timeout (2min on this connection), and lets the CSV path stream
// results batch-by-batch instead of waiting for the whole ticker set.
const SIGNAL_REPORT_TICKER_BATCH_SIZE = 150;

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
// "signals this skill would actually use," not a fully generic raw count —
// unless `filterBySignalType` is false (CSV path only, see module docstring),
// in which case it reports total signal coverage regardless of type.
async function buildSignalAvailabilityReport(slug, tickers, { filterBySignalType = true } = {}) {
  const skill = await prisma.htmlIncrementalSkill.findUnique({
    where:  { slug },
    select: { transcript_signal_types: true, ppt_signal_types: true, annual_report_signal_types: true },
  });
  if (!skill) throw Object.assign(new Error(`HtmlIncrementalSkill not found: ${slug}`), { status: 404 });

  const allTypes = filterBySignalType
    ? [...skill.transcript_signal_types, ...skill.ppt_signal_types, ...skill.annual_report_signal_types]
    : [];

  const byTicker = new Map(tickers.map(t => [t, {
    transcript:    new Map(),
    ppt:           new Map(),
    annual_report: new Map(),
  }]));

  // Aggregated server-side (GROUP BY) instead of fetching every matching
  // signal row into Node and counting them in a JS Map — for a broad
  // signal-type whitelist run against `all` companies, this table can match
  // close to its entire multi-million-row size, and pulling that many raw
  // rows into the API process risks OOMing it. This still has to scan the
  // same rows, but only ~(tickers x doc types x periods) rows now cross the
  // wire instead of every individual signal row. Batched by ticker (see
  // SIGNAL_REPORT_TICKER_BATCH_SIZE) so no single query risks the
  // statement_timeout on a large ticker set. The signal_type filter isn't
  // indexed, so omitting it (filterBySignalType: false) also lets Postgres
  // use a covering index-only scan instead of a heap-filtered one — see
  // module docstring for the measured difference.
  for (const batch of chunk(tickers, SIGNAL_REPORT_TICKER_BATCH_SIZE)) {
    const groups = allTypes.length
      ? await prisma.$queryRaw`
          SELECT ticker, source_doc_type, fiscal_year, quarter, count(*)::int AS cnt
          FROM transcript_signals_v2
          WHERE is_invalidated = false
            AND ticker = ANY(${batch}::text[])
            AND signal_type = ANY(${allTypes}::text[])
          GROUP BY ticker, source_doc_type, fiscal_year, quarter
        `
      : await prisma.$queryRaw`
          SELECT ticker, source_doc_type, fiscal_year, quarter, count(*)::int AS cnt
          FROM transcript_signals_v2
          WHERE is_invalidated = false
            AND ticker = ANY(${batch}::text[])
          GROUP BY ticker, source_doc_type, fiscal_year, quarter
        `;

    for (const r of groups) {
      const bucket = byTicker.get(r.ticker);
      if (!bucket) continue;
      const docType = r.source_doc_type === 'annual_report' ? 'annual_report' : r.source_doc_type === 'ppt' ? 'ppt' : 'transcript';
      const key = docType === 'annual_report' ? r.fiscal_year : `${r.fiscal_year}|${r.quarter}`;
      const m = bucket[docType];
      m.set(key, (m.get(key) ?? 0) + r.cnt);
    }
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
  return cache.wrap(cacheKey('l2-preview', options), PREVIEW_CACHE_TTL_MS, async () => {
    const { slug } = options;
    const allTickers = await resolveTickers(options);
    const { pageTickers: tickers, page, pageSize, totalPages } = paginateTickers(allTickers, options);
    const perTicker = await buildSignalAvailabilityReport(slug, tickers);
    return { slug, tickerCount: allTickers.length, page, pageSize, totalPages, perTicker };
  });
}

// CSV export — same shape as /preview but NOT the same numbers: skips the
// skill's signal_type whitelist filter for speed (see module docstring), so
// this reports total signal coverage per period, not "signals this skill
// would use." Writes directly to the Express response instead of returning
// a string — same reasoning as previewL1MultiDispatchCsv. Only the data-fetch
// is cached (see previewL1MultiDispatchCsv) — the write always runs fresh
// against this request's `res`.
async function previewL2MultiDispatchCsv(options = {}, res) {
  const { slug } = options;
  const perTicker = await cache.wrap(cacheKey('l2-csv', options), CSV_CACHE_TTL_MS, async () => {
    const tickers = await resolveTickers(options);
    return buildSignalAvailabilityReport(slug, tickers, { filterBySignalType: false });
  });
  writeSignalReportCsv(res, perTicker);
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
