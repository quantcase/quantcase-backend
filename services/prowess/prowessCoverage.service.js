'use strict';

/**
 * Data-presence / coverage preview across the two Prowess-fed ingestion
 * pipelines — lets admin see, for a chosen set of tickers, which KPIs
 * actually have data in `prowess_values_new` (fundamentals, annual +
 * quarterly) and whether `nse_equity_new` (daily OHLCV/valuation) has any
 * rows at all. Purely read-only, no dispatch/side effects — mirrors the
 * `groupSlug | tickers | all` + pagination shape of
 * services/pipelineDispatch/{l1,l2}MultiDispatch.service.js's preview
 * endpoints, reusing their pagination/caching utilities directly.
 *
 * `options`:
 *   groupSlug  string    — resolve tickers from a saved CompanyGroup; takes precedence over `tickers`/`all`
 *   tickers    string[]  — explicit ticker list (defaults to DEFAULT_TARGET_TICKERS)
 *   all        boolean   — use every distinct company in DB instead of `tickers`
 *   startFrom  string    — skip tickers alphabetically before this one
 *   kpis       string[]  — explicit KPI abbr override, checked against both annual and quarterly
 *                          for every ticker (returned under a "custom" group) instead of the
 *                          P&L / Balance Sheet / Cash Flow defaults
 *   page, pageSize  number — paginates the resolved ticker list (default 100, max 500)
 */

const prisma = require('../../config/prisma');
const { DEFAULT_TARGET_TICKERS } = require('../pipelineDispatch/targetTickers');
const { paginateTickers } = require('../pipelineDispatch/paginate');
const { TtlCache, cacheKey } = require('../pipelineDispatch/cache');
const { resolveGroupBySlug } = require('../companyGroups');
const {
  resolveProwessName, warmProwessNameCache, fetchAnnualBatchMulti, fetchQuarterlyBatchMulti,
} = require('../../utils/formulaRegistry');

const cache = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 60_000;

// Same ScreenConfig keys lib/financials.js reads to build the screener's
// P&L / Balance Sheet / Cash Flow tables (seeded by scripts/seedKpiGroups.js) —
// reused here as the default "key KPIs per statement" set instead of a
// second hardcoded list, so it stays in sync with whatever admin has already
// curated via /admin/screen-configs.
const DEFAULT_KPI_SCREEN_CONFIG_KEYS = {
  pnl:          { annual: 'financials.pnl.annual',            quarterly: 'financials.pnl.quarterly' },
  balanceSheet: { annual: 'financials.balance-sheet.annual',   quarterly: 'financials.balance-sheet.quarterly' },
  cashflow:     { annual: 'financials.cashflow.annual',        quarterly: 'financials.cashflow.quarterly' },
};

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

async function getDefaultKpiSets() {
  const keys = Object.values(DEFAULT_KPI_SCREEN_CONFIG_KEYS).flatMap(v => [v.annual, v.quarterly]);
  const configs = await prisma.screenConfig.findMany({
    where:   { key: { in: keys } },
    include: { items: { select: { kpi_abbr: true }, orderBy: { display_order: 'asc' } } },
  });
  const abbrsByKey = new Map(configs.map(c => [c.key, c.items.map(i => i.kpi_abbr)]));

  const sets = {};
  for (const [group, { annual, quarterly }] of Object.entries(DEFAULT_KPI_SCREEN_CONFIG_KEYS)) {
    sets[group] = {
      annual:    abbrsByKey.get(annual) ?? [],
      quarterly: abbrsByKey.get(quarterly) ?? [],
    };
  }
  return sets;
}

// Presence is derived from the registry's own bulk fetchers
// (fetchAnnualBatchMulti / fetchQuarterlyBatchMulti in
// utils/formulaRegistry/dataFetcherCore.js) rather than a hand-rolled query
// against prowess_values_new — this is a self-evolving system (new KPI
// abbrs get mapped into the Kpi table without a code deploy), so presence
// must go through the same resolution path everything else uses (C/S
// fallback, call_id-prefixed annual/quarterly split, whatever abbrs exist
// today or get added later) instead of a second copy of that logic that can
// drift. Both fetchers pull every period on record for the company (no
// date-range limit), so the per-period presence maps built below cover full
// history, not just a recent window. Balance-sheet KPIs (TOTAL_ASSETS,
// TOTAL_LIAB, ...) only ever have annual-cadence data in Prowess (FY-end
// snapshots, no interim balance sheets) — verified against the DB — so
// their quarterly presence map correctly comes back empty with no
// special-casing needed here.
async function fetchPresenceByCompany(companyNames, abbrs) {
  if (!companyNames.length || !abbrs.length) return { annual: {}, quarterly: {} };

  const [annualByCo, quarterlyByCo] = await Promise.all([
    fetchAnnualBatchMulti(prisma, companyNames, abbrs),
    fetchQuarterlyBatchMulti(prisma, companyNames, abbrs),
  ]);

  return { annual: annualByCo, quarterly: quarterlyByCo };
}

// Annual periods are always Q4-keyed (fiscal-year-end) — see
// fetchAnnualBatch's own docblock — so the map key is just fiscal_year
// ("FY2025") rather than a redundant "FY2025-Q4"; quarterly periods are
// keyed "FY2025-Q1" etc. Every period the company has *any* data for shows
// up with an explicit true/false (not just omitted when false), so the
// frontend can render a fixed period-column coverage grid per KPI.
function buildPeriodPresenceMap(series, isAnnual) {
  if (!series) return {};
  const map = {};
  for (const p of series) {
    const key = isAnnual ? p.fiscal_year : `${p.fiscal_year}-${p.quarter}`;
    map[key] = p.value != null;
  }
  return map;
}

async function fetchNseSummary(tickers) {
  if (!tickers.length) return new Map();
  const rows = await prisma.nse_equity_new.groupBy({
    by:     ['symbol'],
    where:  { symbol: { in: tickers } },
    _count: { _all: true },
    _min:   { datetime: true },
    _max:   { datetime: true },
  });
  return new Map(rows.map(r => [
    r.symbol,
    { rowCount: r._count._all, firstDate: r._min.datetime, lastDate: r._max.datetime },
  ]));
}

async function previewProwessCoverage(options = {}) {
  return cache.wrap(cacheKey('prowess-coverage-preview', options), PREVIEW_CACHE_TTL_MS, () => previewProwessCoverageUncached(options));
}

async function previewProwessCoverageUncached(options) {
  const allTickers = await resolveTickers(options);
  const { pageTickers: tickers, page, pageSize, totalPages } = paginateTickers(allTickers, options);

  const useCustomKpis = !!options.kpis?.length;
  const kpiSets = useCustomKpis
    ? { custom: { annual: options.kpis, quarterly: options.kpis } }
    : await getDefaultKpiSets();
  const allAbbrs = [...new Set(Object.values(kpiSets).flatMap(v => [...v.annual, ...v.quarterly]))];

  await warmProwessNameCache(prisma, tickers);
  const prowessNameEntries = await Promise.all(tickers.map(async t => [t, await resolveProwessName(prisma, t)]));
  const prowessNameByTicker = new Map(prowessNameEntries);
  const resolvedNames = [...new Set(prowessNameEntries.map(([, name]) => name).filter(Boolean))];

  const [presence, nseByTicker] = await Promise.all([
    fetchPresenceByCompany(resolvedNames, allAbbrs),
    fetchNseSummary(tickers),
  ]);

  const buildAbbrMap = (companyName, abbrs, byCo, isAnnual) =>
    Object.fromEntries(abbrs.map(a => [
      a,
      buildPeriodPresenceMap(companyName ? byCo[companyName]?.[a] : null, isAnnual),
    ]));

  const perTicker = tickers.map(symbol => {
    const prowessName = prowessNameByTicker.get(symbol) ?? null;

    const prowess = {};
    for (const [group, { annual, quarterly }] of Object.entries(kpiSets)) {
      prowess[group] = {
        annual:    buildAbbrMap(prowessName, annual, presence.annual, true),
        quarterly: buildAbbrMap(prowessName, quarterly, presence.quarterly, false),
      };
    }

    const nse = nseByTicker.get(symbol) ?? { rowCount: 0, firstDate: null, lastDate: null };
    return { symbol, prowessName, nse, prowess };
  });

  return { tickerCount: allTickers.length, page, pageSize, totalPages, tickers, kpiSets, perTicker };
}

module.exports = { previewProwessCoverage, getDefaultKpiSets, resolveTickers };
