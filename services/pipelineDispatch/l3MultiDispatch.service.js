'use strict';

/**
 * L3 multi-dispatch — post-html-analysis runs (see
 * services/postHtmlAnalysis.service.js) for a chosen set of tickers, one L3
 * (management/opportunity/deal) or L4 (summary) layer at a time. Named
 * "l3-multi" to keep the L1/L2/L3 pipeline-numbering convention in the admin
 * panel, even though `layerId` lets a single call target L4 too — mirrors
 * L2's structure (services/pipelineDispatch/l2MultiDispatch.service.js)
 * closely: same resolveTickers shape (groupSlug/tickers/all/startFrom, via
 * CompanyGroup), same preview/run split, same real-dispatch-hits-the-real-
 * route approach.
 *
 * No configKey concept here (unlike L2) — PostHtmlAnalysisConfig has no
 * per-group variant dimension yet (only one config per (layer_id, type),
 * globally — see prisma/schema.prisma's PostHtmlAnalysisConfig, unique on
 * [layer_id, type] with no `key` column). CompanyGroup.config_key is
 * unrelated to ticker resolution (groupSlug) and isn't touched here.
 *
 * Preview here is an availability report, not a per-ticker prompt dry-run
 * (same reasoning as L2 — doesn't make sense once a batch is 100+ companies):
 * for L3, whether each of a type's 4 backing HtmlIncrementalSkill lens
 * outputs exist for the ticker; for L4, whether each of the 3 L3 types has a
 * stored PostHtmlAnalysis row. `ready` (available.length > 0) mirrors exactly
 * what the worker itself requires to not fail (see
 * workers/postHtmlAnalysis.js — "No HTML outputs found" / "No L3 analyses
 * found" errors).
 *
 * `options`:
 *   layerId    'l3'|'l4' (default 'l3')
 *   types      string[]  — subset of the layer's valid types; defaults to all of them
 *   groupSlug  string    — resolve tickers from a saved CompanyGroup; takes precedence over `tickers`/`all`
 *   tickers    string[]  — explicit ticker list
 *   all        boolean   — every distinct company in earnings_calls/annual_reports
 *   startFrom  string    — skip tickers alphabetically before this one
 *   force      boolean   — forceRefresh, bypasses the input-hash cache — run only
 *   page, pageSize  number — preview only; paginates the resolved ticker list
 */

const prisma = require('../../config/prisma');
const { resolveGroupBySlug } = require('../companyGroups');
const { dispatchEndpoint } = require('./apiDispatchClient');
const { paginateTickers, chunk } = require('./paginate');
const { TtlCache, cacheKey } = require('./cache');
const { INSIGHT_LENSES } = require('../../lib/insightLenses');
const { L3_TYPES, L4_TYPE } = require('../postHtmlAnalysis.service');

const cache = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 60_000;
const CSV_CACHE_TTL_MS     = 180_000;

// Bounds each availability query to a manageable ticker batch, same reasoning
// as L2's SIGNAL_REPORT_TICKER_BATCH_SIZE — no single query risks the DB's
// statement_timeout on a large ticker set (`all` companies).
const AVAILABILITY_TICKER_BATCH_SIZE = 150;

const ALL_LENS_SLUGS = [...new Set(Object.values(INSIGHT_LENSES).flat())];

function allowedTypesForLayer(layerId) {
  return layerId === 'l4' ? [L4_TYPE] : L3_TYPES;
}

function resolveTypes(layerId, types) {
  const allowed = allowedTypesForLayer(layerId);
  const requested = Array.isArray(types) && types.length ? types : allowed;
  const resolved = requested.filter(t => allowed.includes(t));
  return resolved.length ? resolved : allowed;
}

async function resolveTickers(options) {
  let tickers;
  if (options.groupSlug) {
    tickers = await resolveGroupBySlug(options.groupSlug);
  } else if (options.all) {
    const [callRows, reportRows] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
    ]);
    tickers = [...new Set([...callRows.map(r => r.company), ...reportRows.map(r => r.company)])]
      .filter(Boolean).sort();
  } else {
    tickers = options.tickers?.length ? options.tickers : [];
  }

  if (options.startFrom) {
    const startFrom = options.startFrom.toUpperCase();
    tickers = tickers.filter(t => t.toUpperCase() >= startFrom);
  }
  return tickers;
}

// ticker -> Set(lens slug) for every lens slug that has at least one
// HtmlIncrementalSkillOutput for that ticker — existence only, no period
// resolution needed, unlike fetchLensHtmlOutputs (which also picks the
// single latest one for prompt-building at run time).
async function buildL3AvailabilityMap(tickers) {
  const skills = await prisma.htmlIncrementalSkill.findMany({
    where:  { slug: { in: ALL_LENS_SLUGS } },
    select: { id: true, slug: true },
  });
  const slugBySkillId = new Map(skills.map(s => [s.id, s.slug]));
  const skillIds = skills.map(s => s.id);

  const byTicker = new Map(tickers.map(t => [t, new Set()]));
  for (const batch of chunk(tickers, AVAILABILITY_TICKER_BATCH_SIZE)) {
    const rows = await prisma.htmlIncrementalSkillOutput.findMany({
      where:    { skill_id: { in: skillIds }, ticker: { in: batch } },
      select:   { ticker: true, skill_id: true },
      distinct: ['ticker', 'skill_id'],
    });
    for (const r of rows) byTicker.get(r.ticker)?.add(slugBySkillId.get(r.skill_id));
  }
  return byTicker;
}

// ticker -> Set(L3 type) for every L3 type with a stored PostHtmlAnalysis row.
async function buildL4AvailabilityMap(tickers) {
  const byTicker = new Map(tickers.map(t => [t, new Set()]));
  for (const batch of chunk(tickers, AVAILABILITY_TICKER_BATCH_SIZE)) {
    const rows = await prisma.postHtmlAnalysis.findMany({
      where:  { layer_id: 'l3', type: { in: L3_TYPES }, ticker: { in: batch } },
      select: { ticker: true, type: true },
    });
    for (const r of rows) byTicker.get(r.ticker)?.add(r.type);
  }
  return byTicker;
}

async function buildAvailabilityReport(layerId, types, tickers) {
  if (layerId === 'l4') {
    const availByTicker = await buildL4AvailabilityMap(tickers);
    return tickers.map(ticker => {
      const available = [...(availByTicker.get(ticker) ?? [])];
      const missing = L3_TYPES.filter(t => !available.includes(t));
      return { ticker, types: [{ type: L4_TYPE, available, missing, ready: available.length > 0 }] };
    });
  }

  const availByTicker = await buildL3AvailabilityMap(tickers);
  return tickers.map(ticker => {
    const availSlugs = availByTicker.get(ticker) ?? new Set();
    const typeReports = types.map(type => {
      const required = INSIGHT_LENSES[type];
      const available = required.filter(s => availSlugs.has(s));
      const missing = required.filter(s => !availSlugs.has(s));
      return { type, available, missing, ready: missing.length === 0 };
    });
    return { ticker, types: typeReports };
  });
}

// Dry run — no jobs enqueued, no LLM calls. Sorting deliberately left to the
// frontend, same as L2.
async function previewL3MultiDispatch(options = {}) {
  return cache.wrap(cacheKey('l3-preview', options), PREVIEW_CACHE_TTL_MS, async () => {
    const layerId = options.layerId === 'l4' ? 'l4' : 'l3';
    const types = resolveTypes(layerId, options.types);
    const allTickers = await resolveTickers(options);
    const { pageTickers: tickers, page, pageSize, totalPages } = paginateTickers(allTickers, options);
    const perTicker = await buildAvailabilityReport(layerId, types, tickers);
    return { layerId, types, tickerCount: allTickers.length, page, pageSize, totalPages, perTicker };
  });
}

function escapeCsv(v) {
  return v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
}

// CSV export — same availability data as /preview, flattened to one row per
// (ticker, type). Writes directly to the Express response, same reasoning as
// L1/L2's CSV export (streams row-by-row instead of building the whole
// string first). Uncapped by pagination, full dump by design.
async function previewL3MultiDispatchCsv(options = {}, res) {
  const layerId = options.layerId === 'l4' ? 'l4' : 'l3';
  const types = resolveTypes(layerId, options.types);
  const perTicker = await cache.wrap(cacheKey('l3-csv', options), CSV_CACHE_TTL_MS, async () => {
    const tickers = await resolveTickers(options);
    return buildAvailabilityReport(layerId, types, tickers);
  });

  res.write(['ticker', 'type', 'ready', 'available', 'missing'].join(',') + '\n');
  for (const row of perTicker) {
    for (const t of row.types) {
      res.write([row.ticker, t.type, t.ready, t.available.join(';'), t.missing.join(';')].map(escapeCsv).join(',') + '\n');
    }
  }
  res.end();
}

// Real dispatch — one POST per ticker to the actual POST /api/post-html-analysis
// route (same pattern as L1/L2's dispatchEndpoint calls) rather than calling
// postHtmlAnalysisService.enqueuePostHtmlAnalysis in-process, so every
// validation the route does automatically applies to batch runs too. One
// request per ticker enqueues all of `types` at once (the route already
// fans a single call out into one job per type).
async function runL3MultiDispatch(options = {}) {
  const layerId = options.layerId === 'l4' ? 'l4' : 'l3';
  const types = resolveTypes(layerId, options.types);
  const force = options.force === true;
  const tickers = await resolveTickers(options);
  console.log(`[l3-multi-dispatch] layerId=${layerId} tickers=${tickers.length} types=${types.join(',')} force=${force}`);

  const totals = { queued: 0, failed: 0 };
  const perTicker = [];

  for (const ticker of tickers) {
    try {
      const result = await dispatchEndpoint('/api/post-html-analysis', {
        body: { ticker, layer_id: layerId, types, forceRefresh: force },
      });
      totals.queued++;
      perTicker.push({ ticker, status: 'queued', jobs: result.jobs });
    } catch (err) {
      console.error(`[l3-multi-dispatch] ${ticker}: ${err.message}`);
      totals.failed++;
      perTicker.push({ ticker, status: 'failed', error: err.message });
    }
  }

  console.log(`[l3-multi-dispatch] done — queued=${totals.queued} failed=${totals.failed}`);
  return { records_processed: totals.queued, ...totals, tickerCount: tickers.length, layerId, types, perTicker };
}

module.exports = {
  previewL3MultiDispatch, previewL3MultiDispatchCsv, runL3MultiDispatch,
  resolveTickers, allowedTypesForLayer,
};
