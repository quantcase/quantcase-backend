'use strict';

const { periodLabel } = require('./math');
const { loadIdentityMap } = require('../../lib/prowess');

// ── Name resolution ───────────────────────────────────────────────────────────

let _prowessNameList = null;
function _getProwessNameList() {
  if (_prowessNameList) return _prowessNameList;
  _prowessNameList = Object.values(loadIdentityMap());
  return _prowessNameList;
}

function _normName(s) {
  let out = (s || '')
    .toLowerCase()
    .replace(/\b(ltd\.?|limited|pvt\.?|private|inc\.?|llp|corp\.?|corporation)\b\.?/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Collapse spaced-out single-letter acronyms (Prowess stores many Indian
  // names this way, e.g. "H D F C Bank", "I C I C I Bank", "S B I Life") into
  // one token. Without this, _matchProwessName's word-length filter (>2 chars)
  // drops every individual letter and leaves only a generic trailing word like
  // "bank" to match on — every bank-name candidate then scores a false 1.0 and
  // whichever is iterated first silently wins (this misrouted HDFCBANK to
  // "A U Small Finance Bank Ltd." and ICICIBANK similarly).
  out = out.replace(/\b(?:[a-z0-9] )+[a-z0-9]\b/g, (m) => m.replace(/ /g, ''));
  return out;
}

function _matchProwessName(companyName) {
  const normTarget = _normName(companyName);
  const words      = normTarget.split(' ').filter(w => w.length > 2);
  if (!words.length) return null;

  const names = _getProwessNameList();
  let best = null, bestScore = 0;
  for (const name of names) {
    const normC = _normName(name);
    if (!normC.includes(words[0])) continue;
    const matchCount = words.filter(w => normC.includes(w)).length;
    const score      = matchCount / words.length;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best      = name;
    }
  }
  return best;
}

// Module-level cache — survives across requests in the same process
const _nameCache = new Map();

/**
 * Resolve a ticker to its prowess_values_new company name.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} ticker  e.g. "MSUMI"
 * @returns {Promise<string|null>}
 */
async function resolveProwessName(prisma, ticker) {
  if (_nameCache.has(ticker)) return _nameCache.get(ticker);

  const ec = await prisma.earnings_calls.findFirst({
    where:  { company: ticker },
    select: { company_name: true },
  });
  let prowessName = ec?.company_name ? _matchProwessName(ec.company_name) : null;

  if (!prowessName) {
    const identityMap = loadIdentityMap();
    prowessName = identityMap[ticker] ?? null;
  }

  _nameCache.set(ticker, prowessName);
  return prowessName;
}

/**
 * Bulk-populates _nameCache for many tickers in one query instead of one
 * findFirst per ticker — resolveProwessName's per-ticker query is fine for a
 * handful of companies, but createMultiCompanyResolutionContext calling it
 * once per symbol via Promise.all floods the connection pool before any
 * financial data is even fetched once symbol counts run into the hundreds.
 * Same match logic as resolveProwessName, just batched; already-cached
 * tickers are skipped.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} tickers
 */
async function warmProwessNameCache(prisma, tickers) {
  const uncached = [...new Set(tickers)].filter(t => !_nameCache.has(t));
  if (!uncached.length) return;

  const rows = await prisma.earnings_calls.findMany({
    where:    { company: { in: uncached } },
    select:   { company: true, company_name: true },
    distinct: ['company'],
  });
  const nameByTicker = new Map(rows.map(r => [r.company, r.company_name]));

  const identityMap = loadIdentityMap();
  for (const ticker of uncached) {
    const companyName = nameByTicker.get(ticker);
    let prowessName = companyName ? _matchProwessName(companyName) : null;
    if (!prowessName) prowessName = identityMap[ticker] ?? null;
    _nameCache.set(ticker, prowessName);
  }
}

// ── Period helpers ────────────────────────────────────────────────────────────

function _distinctPeriods(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.fiscal_year}|${r.quarter}`;
    if (!seen.has(key)) seen.set(key, { fiscal_year: r.fiscal_year, quarter: r.quarter });
  }
  return [...seen.values()].sort((a, b) => {
    if (a.fiscal_year !== b.fiscal_year) return a.fiscal_year < b.fiscal_year ? -1 : 1;
    return a.quarter < b.quarter ? -1 : 1;
  });
}

function _buildResult(abbrs, allPeriods, kpiRows) {
  const result = Object.fromEntries(abbrs.map(a => [a, []]));
  const lookup = {};
  for (const r of kpiRows) {
    const key   = `${r.fiscal_year}|${r.quarter}`;
    const value = r.value != null ? r.value / (r.multiplier || 1) : null;
    if (!lookup[r.kpi_abbr]) lookup[r.kpi_abbr] = {};
    lookup[r.kpi_abbr][key] = value;
  }
  for (const abbr of abbrs) {
    result[abbr] = allPeriods.map(p => {
      const key   = `${p.fiscal_year}|${p.quarter}`;
      const value = lookup[abbr]?.[key] ?? null;
      return {
        callId:      null,
        period:      `${p.fiscal_year}-${p.quarter}`,
        fiscal_year: p.fiscal_year,
        quarter:     p.quarter,
        start_date:  p.start_date ?? null,
        end_date:    p.end_date ?? null,
        call_date:   null,
        value,
        abbrUsed:    value != null ? abbr : null,
      };
    });
  }
  return result;
}

// ── Time-series fetchers (accept ticker, resolve prowessName internally) ──────

/**
 * Fetch all annual values for a single KPI abbr for a ticker from prowess_values_new.
 * Prefers consolidated (source_type='C'); falls back to standalone.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} ticker
 * @param {string} abbr
 * @returns {Promise<Array<{ callId: null, period, fiscal_year, quarter, call_date: null, value, abbrUsed }>>}
 */
async function fetchTimeSeries(prisma, ticker, abbr) {
  const prowessName = await resolveProwessName(prisma, ticker);
  if (!prowessName) return [];

  const [allPeriods, kpiRows] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:    { company: prowessName, source_type: 'C' },
      select:   { fiscal_year: true, quarter: true, start_date: true, end_date: true },
      distinct: ['fiscal_year', 'quarter'],
      orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: abbr, source_type: 'C' },
      select:  { fiscal_year: true, quarter: true, value: true, multiplier: true },
    }),
  ]);

  const [allPeriodsEff, kpiRowsEff] = allPeriods.length ? [allPeriods, kpiRows] : await Promise.all([
    prisma.prowessValueNew.findMany({
      where:    { company: prowessName, source_type: 'S' },
      select:   { fiscal_year: true, quarter: true, start_date: true, end_date: true },
      distinct: ['fiscal_year', 'quarter'],
      orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: abbr, source_type: 'S' },
      select:  { fiscal_year: true, quarter: true, value: true, multiplier: true },
    }),
  ]);

  const kpiMap = new Map(
    kpiRowsEff.map(r => [`${r.fiscal_year}|${r.quarter}`, r.value != null ? r.value / (r.multiplier || 1) : null])
  );

  return allPeriodsEff.map(p => {
    const value = kpiMap.get(`${p.fiscal_year}|${p.quarter}`) ?? null;
    return {
      callId:      null,
      period:      `${p.fiscal_year}-${p.quarter}`,
      fiscal_year: p.fiscal_year,
      quarter:     p.quarter,
      call_date:   null,
      value,
      abbrUsed:    value != null ? abbr : null,
    };
  });
}

/**
 * Fetch multiple KPI abbrs in a single DB round-trip for a ticker.
 * Prefers consolidated; falls back to standalone.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string}   ticker
 * @param {string[]} abbrs
 * @returns {Promise<Record<string, Array<{ callId: null, period, fiscal_year, quarter, call_date: null, value, abbrUsed }>>>}
 */
async function fetchTimeSeriesBatch(prisma, ticker, abbrs) {
  const prowessName = await resolveProwessName(prisma, ticker);
  const result      = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!prowessName) return result;

  let [allPeriods, kpiRows] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:    { company: prowessName, source_type: 'C' },
      select:   { fiscal_year: true, quarter: true, start_date: true, end_date: true },
      distinct: ['fiscal_year', 'quarter'],
      orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'C' },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  if (!allPeriods.length) {
    [allPeriods, kpiRows] = await Promise.all([
      prisma.prowessValueNew.findMany({
        where:    { company: prowessName, source_type: 'S' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      prisma.prowessValueNew.findMany({
        where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S' },
        select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);
  }

  return _buildResult(abbrs, allPeriods, kpiRows);
}

// ── Annual / quarterly split batches ─────────────────────────────────────────

/**
 * Annual-only batch from prowess_values_new (callId prefix: prowess_new_*).
 * Q4 rows represent full fiscal-year audited figures.
 * Prefers consolidated (source_type='C'); falls back to standalone.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string}   ticker
 * @param {string[]} abbrs
 * @returns {Promise<Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>>}
 */
async function fetchAnnualBatch(prisma, ticker, abbrs) {
  const prowessName = await resolveProwessName(prisma, ticker);
  const result      = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!prowessName) return result;

  let [allPeriods, kpiRows] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:    { company: prowessName, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select:   { fiscal_year: true, quarter: true, start_date: true, end_date: true },
      distinct: ['fiscal_year', 'quarter'],
      orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  if (!allPeriods.length) {
    [allPeriods, kpiRows] = await Promise.all([
      prisma.prowessValueNew.findMany({
        where:    { company: prowessName, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      prisma.prowessValueNew.findMany({
        where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
        select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);
  }

  return _buildResult(abbrs, allPeriods, kpiRows);
}

/**
 * Quarterly-only batch from prowess_values_new (callId prefix: prowess_qtr_*).
 * Always standalone (source_type='S'). Individual quarter P&L rows only —
 * use fetchAnnualBatch for balance-sheet snapshots.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string}   ticker
 * @param {string[]} abbrs
 * @returns {Promise<Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>>}
 */
async function fetchQuarterlyBatch(prisma, ticker, abbrs) {
  const prowessName = await resolveProwessName(prisma, ticker);
  const result      = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!prowessName) return result;

  const [allPeriods, kpiRows] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:    { company: prowessName, source_type: 'S', callId: { startsWith: 'prowess_qtr_' } },
      select:   { fiscal_year: true, quarter: true, start_date: true, end_date: true },
      distinct: ['fiscal_year', 'quarter'],
      orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_qtr_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  return _buildResult(abbrs, allPeriods, kpiRows);
}

// ── Prowess time-series (accepts already-resolved companyName) ────────────────

/**
 * Annual time-series for a single KPI from prowess_values_new.
 * Accepts the already-resolved prowess company name (not ticker).
 * Returns rows ordered oldest → newest.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} companyName  — already-resolved prowess company name
 * @param {string} abbr
 */
async function fetchProwessTimeSeries(prisma, companyName, abbr) {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (fiscal_year)
           kpi_abbr, value, fiscal_year, quarter
    FROM   prowess_values_new
    WHERE  company  = ${companyName}
      AND  kpi_abbr = ${abbr}
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY fiscal_year ASC, source_type ASC
  `;
  return rows.map(r => ({
    period:      `${r.fiscal_year}`,
    fiscal_year: r.fiscal_year,
    quarter:     r.quarter,
    value:       r.value != null ? parseFloat(r.value) : null,
    abbrUsed:    r.value != null ? abbr : null,
  }));
}

// ── Multi-company batches (one query for N companies, not N round trips) ─────
// Same query shape/semantics as fetchAnnualBatch/fetchQuarterlyBatch, batched
// across companies the way fetchKpiMapsMultiBatch (dataFetcherKpiMaps.js)
// already batches fetchKpiMapsMulti — built for createMultiCompanyResolutionContext.

function _groupByCompany(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.company)) map.set(r.company, []);
    map.get(r.company).push(r);
  }
  return map;
}

/**
 * Bulk version of fetchAnnualBatch. Preserves the per-company C-preferred/
 * S-fallback logic (a company with any consolidated periods uses only those;
 * a company with none falls back to its own standalone rows) — not a
 * blanket "if nobody has C data, everybody uses S" shortcut.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} companyNames — already-resolved prowess company names
 * @param {string[]} abbrs
 * @returns {Promise<Object<string, Record<string, Array>>>} keyed by company name, each value shaped like fetchAnnualBatch's return
 */
async function fetchAnnualBatchMulti(prisma, companyNames, abbrs) {
  if (!companyNames.length) return {};

  const [periodRowsC, kpiRowsC] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:   { company: { in: companyNames }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select:  { company: true, fiscal_year: true, quarter: true },
      distinct: ['company', 'fiscal_year', 'quarter'],
      orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:  { company: { in: companyNames }, kpi_abbr: { in: abbrs }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select: { company: true, fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  const periodsByCoC = _groupByCompany(periodRowsC);
  const kpisByCoC     = _groupByCompany(kpiRowsC);
  const companiesNeedingS = companyNames.filter(c => !periodsByCoC.has(c));

  let periodsByCoS = new Map(), kpisByCoS = new Map();
  if (companiesNeedingS.length) {
    const [periodRowsS, kpiRowsS] = await Promise.all([
      prisma.prowessValueNew.findMany({
        where:   { company: { in: companiesNeedingS }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
        select:  { company: true, fiscal_year: true, quarter: true },
        distinct: ['company', 'fiscal_year', 'quarter'],
        orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      prisma.prowessValueNew.findMany({
        where:  { company: { in: companiesNeedingS }, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
        select: { company: true, fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);
    periodsByCoS = _groupByCompany(periodRowsS);
    kpisByCoS    = _groupByCompany(kpiRowsS);
  }

  const result = {};
  for (const company of companyNames) {
    const periods = periodsByCoC.get(company);
    result[company] = periods
      ? _buildResult(abbrs, periods, kpisByCoC.get(company) ?? [])
      : _buildResult(abbrs, periodsByCoS.get(company) ?? [], kpisByCoS.get(company) ?? []);
  }
  return result;
}

/**
 * Bulk version of fetchQuarterlyBatch — always standalone (source_type='S'),
 * no C/S fallback needed (matches fetchQuarterlyBatch's own semantics).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} companyNames
 * @param {string[]} abbrs
 * @returns {Promise<Object<string, Record<string, Array>>>} keyed by company name
 */
async function fetchQuarterlyBatchMulti(prisma, companyNames, abbrs) {
  if (!companyNames.length) return {};

  const [periodRows, kpiRows] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:   { company: { in: companyNames }, source_type: 'S', callId: { startsWith: 'prowess_qtr_' } },
      select:  { company: true, fiscal_year: true, quarter: true },
      distinct: ['company', 'fiscal_year', 'quarter'],
      orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:  { company: { in: companyNames }, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_qtr_' } },
      select: { company: true, fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  const periodsByCo = _groupByCompany(periodRows);
  const kpisByCo    = _groupByCompany(kpiRows);

  const result = {};
  for (const company of companyNames) {
    result[company] = _buildResult(abbrs, periodsByCo.get(company) ?? [], kpisByCo.get(company) ?? []);
  }
  return result;
}

module.exports = {
  resolveProwessName,
  warmProwessNameCache,
  fetchTimeSeries,
  fetchTimeSeriesBatch,
  fetchAnnualBatch,
  fetchQuarterlyBatch,
  fetchAnnualBatchMulti,
  fetchQuarterlyBatchMulti,
  fetchProwessTimeSeries,
};
