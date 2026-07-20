'use strict';

/**
 * Request-scoped, per-(company) memoization layer that lets resolveMetric be
 * a self-fetching, async "just call it" API without turning every raw-leaf
 * reference into its own DB round trip. Create one context per incoming
 * request (or per company being resolved) and thread it through every
 * resolveMetric(abbr, ctx) call — repeated calls share the same underlying
 * bulk fetches.
 *
 * Internally, on first need for a given frequency it does exactly ONE bulk
 * fetch (fetchAnnualBatch / fetchQuarterlyBatch, reused unmodified from
 * dataFetcherCore.js) covering every raw abbr currently known to the
 * registry — same query shape/cost as today's callers already issue, just
 * automated instead of manually specified.
 */

const { resolveProwessName, warmProwessNameCache, fetchAnnualBatch, fetchQuarterlyBatch, fetchAnnualBatchMulti, fetchQuarterlyBatchMulti } = require('./dataFetcherCore');
const { fetchMarketSnapshot, fetchMarketSnapshots, fetchAllDailySeries, DAILY_SERIES_FIELDS, DAILY_RESAMPLE_MODE, resampleToFrequency, resampleToPeriods } = require('./dataFetcherMarket');
const { getProwessRawAbbrs, getDailyRawAbbrs } = require('./registryCache');
const companyGroups = require('../../services/companyGroups/resolver');
const prismaDefault = require('../../config/prisma');

// Which nse_equity_new column backs each daily-frequency Kpi abbr — shared
// with dataFetcherMarket.js's fetchDailySeries so current-value and series
// resolution always agree on the same mapping.
const DAILY_ABBR_TO_SNAPSHOT_FIELD = DAILY_SERIES_FIELDS;

function _seriesToPoints(seriesRows) {
  // fetchAnnualBatch/fetchQuarterlyBatch return period-padded arrays
  // (one entry per known period, value null where missing), oldest → newest.
  // start_date/end_date (when present) are each period's real fiscal-quarter
  // boundary -- kept so daily-native abbrs can be resampled onto this exact
  // period list, see getProwessSeriesMap's daily-abbr merge below.
  return (seriesRows ?? []).map(r => ({
    value: r.value, fiscal_year: r.fiscal_year, quarter: r.quarter,
    start_date: r.start_date ?? null, end_date: r.end_date ?? null,
  }));
}

/**
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} [opts.prisma]
 * @param {string} opts.symbol   — ticker, e.g. "RELIANCE" (used for nse_equity_new + CompanyGroup membership)
 * @param {string} [opts.company] — already-resolved Prowess company name; resolved from `symbol` if omitted
 * @param {string} [opts.frequency] — explicit default frequency for calls that don't pass their own;
 *   left undefined when omitted (not defaulted to 'annual') so financial.js's precedence chain can
 *   tell "caller asked for X" apart from "caller didn't say" — see resolveMetric's frequency selection.
 * @param {string} [opts.resampleMode] — 'average'|'latest', overrides DAILY_RESAMPLE_MODE for every
 *   daily-native abbr resolved through THIS context. Debug/testing knob only (admin.kpis.service.js's
 *   previewKpi threads its ?resample_mode= query param through here) — not persisted anywhere, and no
 *   other caller sets it, so every other context still uses each abbr's fixed default policy.
 */
function createResolutionContext({ prisma, symbol, company, frequency, resampleMode } = {}) {
  const db = prisma ?? prismaDefault;

  let companyNamePromise = company ? Promise.resolve(company) : null;
  function getCompanyName() {
    if (!companyNamePromise) companyNamePromise = resolveProwessName(db, symbol);
    return companyNamePromise;
  }

  // Map<'annual'|'quarterly', Promise<Record<abbr, Array<{value, fiscal_year, quarter}>>>>
  const prowessSeriesPromises = new Map();
  function getProwessSeriesMap(freq) {
    if (!prowessSeriesPromises.has(freq)) {
      prowessSeriesPromises.set(freq, (async () => {
        const companyName = await getCompanyName();
        if (!companyName) return {};
        const abbrs = await getProwessRawAbbrs();
        if (!abbrs.length) return {};
        const raw = freq === 'quarterly'
          ? await fetchQuarterlyBatch(db, symbol, abbrs)
          : await fetchAnnualBatch(db, symbol, abbrs);
        const out = {};
        for (const abbr of abbrs) out[abbr] = _seriesToPoints(raw[abbr]);

        // Merge in daily-native abbrs (PRICE/PE_DAILY/MCAP_SNAPSHOT), resampled
        // onto this SAME period list (real start_date/end_date per period, not
        // a guessed calendar boundary) -- so a formula that references one of
        // them mid-walk (_resolveAtIndex, e.g. ENTERPRISE_VALUE's MCAP_SNAPSHOT
        // term inside EV_EBITDA's historical series) finds a real, correctly
        // fiscal-period-aligned value at seriesMap[abbr][i] instead of nothing.
        // No change needed in _resolveAtIndex itself -- it already reads
        // straight from this map.
        const periods = out[abbrs[0]];
        if (periods?.length) {
          const dailyMap = await getDailySeriesMap();
          for (const dailyAbbr of Object.keys(DAILY_SERIES_FIELDS)) {
            const mode = resampleMode ?? DAILY_RESAMPLE_MODE[dailyAbbr];
            if (!mode) continue;
            out[dailyAbbr] = resampleToPeriods(dailyMap[dailyAbbr] ?? [], periods, mode);
          }
        }
        return out;
      })());
    }
    return prowessSeriesPromises.get(freq);
  }

  let dailySnapshotPromise = null;
  function getDailySnapshot() {
    if (!dailySnapshotPromise) dailySnapshotPromise = fetchMarketSnapshot(db, symbol);
    return dailySnapshotPromise;
  }

  // One bulk query serves every daily abbr (PRICE/PE_DAILY/MCAP_SNAPSHOT) —
  // memoized the same way getProwessSeriesMap is for quarterly/annual.
  let dailySeriesMapPromise = null;
  function getDailySeriesMap() {
    if (!dailySeriesMapPromise) dailySeriesMapPromise = fetchAllDailySeries(db, symbol);
    return dailySeriesMapPromise;
  }

  // Map<groupSlug, Promise<boolean>>
  const groupMembership = new Map();
  function isCompanyInGroup(slug) {
    if (!groupMembership.has(slug)) {
      groupMembership.set(slug, (async () => {
        const group = await db.companyGroup.findUnique({ where: { slug } });
        if (!group) return false;
        const tickers = await companyGroups.resolveGroup(group);
        return tickers.includes(symbol);
      })());
    }
    return groupMembership.get(slug);
  }

  /**
   * Non-null-filtered points, oldest → newest, for CAGR/AVG/SUM.
   *
   * Routing is decided by whether `abbr` is a daily-native (nse_equity_new-
   * backed) abbr, not by `freq` — the resolver is agnostic to which cadence
   * is being asked for. A daily-native abbr asked for at its own native
   * 'daily' is served directly; asked at a coarser 'quarterly'/'annual', its
   * native series is bucketed via DAILY_RESAMPLE_MODE (see
   * dataFetcherMarket.js) instead of silently returning nothing.
   */
  async function getSeries(abbr, freq) {
    if (DAILY_SERIES_FIELDS[abbr]) {
      const map = await getDailySeriesMap();
      const native = map[abbr] ?? [];
      if (freq === 'daily' || !freq) return native;
      const mode = resampleMode ?? DAILY_RESAMPLE_MODE[abbr];
      if (!mode) return []; // no resample policy declared for this abbr -- can't serve a coarser request
      return resampleToFrequency(native, freq, mode);
    }
    const map = await getProwessSeriesMap(freq);
    return map[abbr] ?? [];
  }

  /** Whole per-frequency raw series map — every raw abbr's array is padded to the same period list/length. */
  async function getSeriesMap(freq) {
    if (freq === 'daily') return getDailySeriesMap();
    return getProwessSeriesMap(freq);
  }

  /** Latest non-null value for a raw abbr — matches fetchKpiMap's "latest period that has a value" semantics. */
  async function getCurrentValue(abbr, freq) {
    if (DAILY_SERIES_FIELDS[abbr]) {
      if (freq === 'daily' || !freq) {
        const field = DAILY_ABBR_TO_SNAPSHOT_FIELD[abbr];
        if (!field) return null;
        const snap = await getDailySnapshot();
        return snap ? snap[field] ?? null : null;
      }
      const points = await getSeries(abbr, freq); // resampled to freq
      return points.length ? points[points.length - 1].value : null;
    }
    const points = await getSeries(abbr, freq);
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].value != null) return points[i].value;
    }
    return null;
  }

  /** Strictly-adjacent current/previous pair (last two known periods) — matches today's prevKpiMap delta semantics. */
  async function getCurrentAndPrevious(abbr, freq) {
    if (DAILY_SERIES_FIELDS[abbr]) {
      if (freq === 'daily' || !freq) return { curr: await getCurrentValue(abbr, freq), prev: null };
      const points = await getSeries(abbr, freq); // resampled to freq
      const curr = points.length ? points[points.length - 1].value : null;
      const prev = points.length > 1 ? points[points.length - 2].value : null;
      return { curr, prev };
    }
    const map = await getProwessSeriesMap(freq);
    const points = map[abbr] ?? [];
    const curr = points.length ? points[points.length - 1].value : null;
    const prev = points.length > 1 ? points[points.length - 2].value : null;
    return { curr, prev };
  }

  /** Period (fiscal_year/quarter, or date for daily) the value getCurrentValue would return came from — admin-preview display only, never used in computation. */
  async function getCurrentPeriod(abbr, freq) {
    if (DAILY_SERIES_FIELDS[abbr]) {
      if (freq === 'daily' || !freq) {
        const field = DAILY_ABBR_TO_SNAPSHOT_FIELD[abbr];
        if (!field) return null;
        const snap = await getDailySnapshot();
        return snap?.datetime ? { frequency: 'daily', date: snap.datetime } : null;
      }
      // Always 'daily' here, never `freq` -- a resampled value is still
      // fundamentally "as of a specific date", regardless of which coarser
      // frequency it was requested at. Reporting `freq` (e.g. 'annual')
      // alongside a `date` field produced a self-contradictory period shape
      // that confused the admin preview UI (looked like neither a normal
      // daily period nor a normal fiscal one).
      const points = await getSeries(abbr, freq); // resampled to freq
      return points.length ? { frequency: 'daily', date: points[points.length - 1].date } : null;
    }
    const points = await getSeries(abbr, freq);
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].value != null) return { frequency: freq, fiscal_year: points[i].fiscal_year, quarter: points[i].quarter };
    }
    return null;
  }

  return {
    symbol,
    frequency,
    getCompanyName,
    getSeries,
    getSeriesMap,
    getCurrentValue,
    getCurrentAndPrevious,
    getCurrentPeriod,
    isCompanyInGroup,
  };
}

/**
 * Lightweight context for callers that have already fetched their own flat
 * kpiMap/prevKpiMap (screener.controller.js does its own bulk queries up
 * front) — evaluates formulas (incl. fallback_abbrs chains and DELTA, via
 * prevKpiMap) against that data with zero DB access. CAGR/AVG/SUM and
 * company-group variant selection (BFSI) are not available in this mode
 * (no series/company context) and resolve to null/never-triggered — none of
 * the formulas this mode is used for in practice need them.
 *
 * @param {object} opts
 * @param {Record<string, number|null>} opts.kpiMap
 * @param {Record<string, number|null>} [opts.prevKpiMap]
 * @param {string} [opts.frequency]
 */
function createFlatContext({ kpiMap = {}, prevKpiMap = null, frequency = 'annual' } = {}) {
  return {
    frequency,
    getCurrentValue: async (abbr) => kpiMap[abbr] ?? null,
    getCurrentAndPrevious: async (abbr) => ({ curr: kpiMap[abbr] ?? null, prev: prevKpiMap?.[abbr] ?? null }),
    getSeries: async () => [],
    getSeriesMap: async () => ({}),
    getCurrentPeriod: async () => null,
    isCompanyInGroup: async () => false,
  };
}

/**
 * Lightweight context for callers that have already built a single metric's
 * time series locally (e.g. screener.controller.js's epsSeriesAsc /
 * roceSeriesAsc) and just want CAGR()/AVG()/SUM() evaluated against it — no
 * DB access. Only correct when the target formula references exactly one
 * base abbr (true for every CAGR/AVG-type entry today); `series` is returned
 * for whichever abbr is asked, regardless of name.
 *
 * @param {object} opts
 * @param {Array<{ value: number|null }>} opts.series — oldest → newest
 * @param {string} [opts.frequency]
 */
function createSeriesOnlyContext({ series = [], frequency = 'annual' } = {}) {
  return {
    frequency,
    getCurrentValue: async () => null,
    getCurrentAndPrevious: async () => ({ curr: null, prev: null }),
    getSeries: async () => series,
    getSeriesMap: async () => ({}),
    getCurrentPeriod: async () => null,
    isCompanyInGroup: async () => false,
  };
}

/**
 * Batched counterpart to createResolutionContext, for callers resolving the
 * same handful of metrics for many companies at once (e.g. Peer Comparison)
 * — turns what would be N self-fetching contexts (N sets of bulk queries)
 * into a small constant number of bulk queries total, then hands back one
 * lightweight resCtx per symbol backed by slices of the shared batch data.
 *
 * Only current-value resolution is supported for daily abbrs here (no
 * per-company daily series) — every current caller (Peer Comparison) only
 * ever needs a single latest value (pe, marketCapCr, ...), never a daily
 * trend, so there's no batched daily-series fetcher to match
 * fetchAnnualBatchMulti/fetchQuarterlyBatchMulti. Add one if a future caller
 * needs it instead of quietly special-casing around this gap.
 *
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} [opts.prisma]
 * @param {string[]} opts.symbols
 * @param {string} [opts.frequency]
 * @returns {Promise<Map<string, import('./resolutionContext').ResolutionContext>>} keyed by symbol
 */
async function createMultiCompanyResolutionContext({ prisma, symbols, frequency = 'annual' } = {}) {
  const db = prisma ?? prismaDefault;

  await warmProwessNameCache(db, symbols);
  const companyNames = await Promise.all(symbols.map(sym => resolveProwessName(db, sym)));
  const symbolToCompany = new Map(symbols.map((sym, i) => [sym, companyNames[i]]));
  const validCompanyNames = [...new Set(companyNames.filter(Boolean))];

  const abbrs = await getProwessRawAbbrs();

  const [annualBatch, quarterlyBatch, snapshots] = await Promise.all([
    abbrs.length && validCompanyNames.length ? fetchAnnualBatchMulti(db, validCompanyNames, abbrs) : {},
    abbrs.length && validCompanyNames.length ? fetchQuarterlyBatchMulti(db, validCompanyNames, abbrs) : {},
    fetchMarketSnapshots(db, symbols),
  ]);

  // Shared across every per-company context in this batch — the same
  // CompanyGroup row (e.g. 'bfsi') is looked up once, not once per peer.
  const groupRowCache = new Map(); // slug -> Promise<CompanyGroup|null>
  function getGroupRow(slug) {
    if (!groupRowCache.has(slug)) groupRowCache.set(slug, db.companyGroup.findUnique({ where: { slug } }));
    return groupRowCache.get(slug);
  }

  const contexts = new Map();
  for (const symbol of symbols) {
    const companyName = symbolToCompany.get(symbol);
    const snap = snapshots[symbol.toUpperCase()] ?? null;

    const annualSeriesMap = {};
    const quarterlySeriesMap = {};
    if (companyName) {
      const annualForCompany = annualBatch[companyName] ?? {};
      const quarterlyForCompany = quarterlyBatch[companyName] ?? {};
      for (const abbr of abbrs) {
        annualSeriesMap[abbr] = _seriesToPoints(annualForCompany[abbr]);
        quarterlySeriesMap[abbr] = _seriesToPoints(quarterlyForCompany[abbr]);
      }
    }

    function seriesMapFor(freq) {
      if (freq === 'daily') return {};
      return freq === 'quarterly' ? quarterlySeriesMap : annualSeriesMap;
    }

    async function getSeries(abbr, freq) {
      return seriesMapFor(freq)[abbr] ?? [];
    }
    async function getSeriesMap(freq) {
      return seriesMapFor(freq);
    }
    async function getCurrentValue(abbr, freq) {
      if (freq === 'daily') {
        const field = DAILY_ABBR_TO_SNAPSHOT_FIELD[abbr];
        return field && snap ? snap[field] ?? null : null;
      }
      const points = seriesMapFor(freq)[abbr] ?? [];
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].value != null) return points[i].value;
      }
      return null;
    }
    async function getCurrentAndPrevious(abbr, freq) {
      if (freq === 'daily') return { curr: await getCurrentValue(abbr, freq), prev: null };
      const points = seriesMapFor(freq)[abbr] ?? [];
      const curr = points.length ? points[points.length - 1].value : null;
      const prev = points.length > 1 ? points[points.length - 2].value : null;
      return { curr, prev };
    }
    async function isCompanyInGroup(slug) {
      const group = await getGroupRow(slug);
      if (!group) return false;
      const tickers = await companyGroups.resolveGroup(group);
      return tickers.includes(symbol);
    }
    async function getCurrentPeriod(abbr, freq) {
      if (freq === 'daily') {
        const field = DAILY_ABBR_TO_SNAPSHOT_FIELD[abbr];
        return field && snap?.datetime ? { frequency: 'daily', date: snap.datetime } : null;
      }
      const points = seriesMapFor(freq)[abbr] ?? [];
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].value != null) return { frequency: freq, fiscal_year: points[i].fiscal_year, quarter: points[i].quarter };
      }
      return null;
    }

    contexts.set(symbol, {
      symbol,
      frequency,
      getCompanyName: async () => companyName,
      getSeries,
      getSeriesMap,
      getCurrentValue,
      getCurrentAndPrevious,
      getCurrentPeriod,
      isCompanyInGroup,
    });
  }

  return contexts;
}

module.exports = {
  createResolutionContext, createFlatContext, createSeriesOnlyContext,
  createMultiCompanyResolutionContext, getDailyRawAbbrs,
};
