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
    const targetWords = normC.split(' ');
    if (!targetWords.includes(words[0])) continue;
    const matchCount = words.filter(w => targetWords.includes(w)).length;
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

  const identityMap = loadIdentityMap();
  let prowessName = identityMap[ticker] ?? null;

  if (!prowessName) {
    const ec = await prisma.earnings_calls.findFirst({
      where:  { company: ticker },
      select: { company_name: true },
    });
    prowessName = ec?.company_name ? _matchProwessName(ec.company_name) : null;
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

  const identityMap = loadIdentityMap();
  const needEc = [];
  for (const ticker of uncached) {
    const fromMap = identityMap[ticker];
    if (fromMap) {
      _nameCache.set(ticker, fromMap);
    } else {
      needEc.push(ticker);
    }
  }
  if (!needEc.length) return;

  const rows = await prisma.earnings_calls.findMany({
    where:    { company: { in: needEc } },
    select:   { company: true, company_name: true },
    distinct: ['company'],
  });
  const nameByTicker = new Map(rows.map(r => [r.company, r.company_name]));

  for (const ticker of needEc) {
    const companyName = nameByTicker.get(ticker);
    const prowessName = companyName ? _matchProwessName(companyName) : null;
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
 * One row per (fiscal_year, quarter) for a company/source_type/callId-prefix,
 * carrying the period's start_date/end_date boundary — the thing
 * resampleToPeriods needs to bucket a daily-native abbr (PRICE/MCAP_SNAPSHOT)
 * onto real fiscal-quarter boundaries (see resolutionContext.js's
 * getProwessSeriesMap). A plain `distinct(['fiscal_year','quarter'])`
 * findMany can't express *which* of the ~20-30 kpi_abbr rows sharing a
 * period to prefer: balance-sheet/snapshot metrics (BORR_TOTAL, CASH_EQUIV,
 * CURR_ASSETS, ...) are correctly stored with start_date NULL (a balance
 * sheet has no "start", only an as-of date) alongside P&L/flow metrics
 * (TOTAL_INCOME, ...) that correctly carry the real start_date — Prisma's
 * distinct then non-deterministically returns whichever row the scan hits
 * first, sometimes a snapshot row, silently nulling that whole period's
 * start_date (this is what caused PB_TTM/MCAP_SALES/PE_DAILY's chart lines
 * to go null on SOME quarters but not others, not a missing-data gap).
 * DISTINCT ON + ORDER BY start_date (Postgres default: NULLS LAST for ASC)
 * picks a non-null-start_date row whenever one exists for that period.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} company
 * @param {string} sourceType - 'C' | 'S'
 * @param {string} callIdPrefix - e.g. 'prowess_new_' | 'prowess_qtr_'
 * @returns {Promise<Array<{fiscal_year, quarter, start_date, end_date}>>} ascending
 */
async function _fetchPeriodBoundaries(prisma, company, sourceType, callIdPrefix) {
  return prisma.$queryRaw`
    SELECT DISTINCT ON (fiscal_year, quarter)
           fiscal_year, quarter, start_date, end_date
    FROM   prowess_values_new
    WHERE  company = ${company} AND source_type = ${sourceType} AND call_id LIKE ${callIdPrefix + '%'}
    ORDER  BY fiscal_year, quarter, start_date
  `;
}

/**
 * Annual-only batch from prowess_values_new (callId prefix: prowess_new_*).
 * Q4 rows represent full fiscal-year audited figures.
 * Prefers consolidated (source_type='C'); falls back to standalone -- per
 * ABBR, not per company. Different annual templates get uploaded with
 * different C/S coverage (e.g. a P&L-only "Non-BFSI" file uploaded as both
 * C+S, a balance-sheet "rolled-up" file uploaded as S-only for the same
 * company) -- gating the whole batch on "does this company have ANY C row"
 * meant a company with C data for unrelated abbrs would get null for every
 * requested abbr that only exists under S, even though the S data was right
 * there. Each abbr now independently uses its own C rows if it has any, S
 * otherwise.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string}   ticker
 * @param {string[]} abbrs
 * @returns {Promise<Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>>}
 */
async function fetchAnnualBatch(prisma, ticker, abbrs, reportType) {
  const prowessName = await resolveProwessName(prisma, ticker);
  const result      = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!prowessName) return result;

  const [periodsC, periodsS, rowsC, rowsS] = await Promise.all([
    _fetchPeriodBoundaries(prisma, prowessName, 'C', 'prowess_new_'),
    _fetchPeriodBoundaries(prisma, prowessName, 'S', 'prowess_new_'),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  let allPeriods = [];
  let kpiRows = [];

  if (reportType === 'S') {
    allPeriods = periodsS;
    kpiRows = rowsS;
  } else {
    allPeriods = periodsC.length ? periodsC : periodsS;
    const abbrsWithC = new Set(rowsC.map(r => r.kpi_abbr));
    kpiRows = [...rowsC, ...rowsS.filter(r => !abbrsWithC.has(r.kpi_abbr))];
  }

  return _buildResult(abbrs, allPeriods, kpiRows);
}

/**
 * Quarterly-only batch from prowess_values_new (callId prefix: prowess_qtr_*).
 * Uses same Best Available logic (prefers C over S) unless reportType='S' is requested.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string}   ticker
 * @param {string[]} abbrs
 * @param {string}   [reportType]
 * @returns {Promise<Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>>}
 */
async function fetchQuarterlyBatch(prisma, ticker, abbrs, reportType) {
  const prowessName = await resolveProwessName(prisma, ticker);
  const result      = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!prowessName) return result;

  const [periodsC, periodsS, rowsC, rowsS] = await Promise.all([
    _fetchPeriodBoundaries(prisma, prowessName, 'C', 'prowess_qtr_'),
    _fetchPeriodBoundaries(prisma, prowessName, 'S', 'prowess_qtr_'),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'C', callId: { startsWith: 'prowess_qtr_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_qtr_' } },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  let allPeriods = [];
  let kpiRows = [];

  if (reportType === 'S') {
    allPeriods = periodsS;
    kpiRows = rowsS;
  } else {
    allPeriods = periodsC.length ? periodsC : periodsS;
    const abbrsWithC = new Set(rowsC.map(r => r.kpi_abbr));
    kpiRows = [...rowsC, ...rowsS.filter(r => !abbrsWithC.has(r.kpi_abbr))];
  }

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
 * Bulk version of fetchAnnualBatch. Same per-ABBR C-preferred/S-fallback
 * logic (see fetchAnnualBatch's docblock for why per-company gating was
 * wrong) — for each company, each requested abbr independently uses its own
 * C rows if it has any, S otherwise.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} companyNames — already-resolved prowess company names
 * @param {string[]} abbrs
 * @returns {Promise<Object<string, Record<string, Array>>>} keyed by company name, each value shaped like fetchAnnualBatch's return
 */
async function fetchAnnualBatchMulti(prisma, companyNames, abbrs) {
  if (!companyNames.length) return {};

  const [periodRowsC, periodRowsS, kpiRowsC, kpiRowsS] = await Promise.all([
    prisma.prowessValueNew.findMany({
      where:   { company: { in: companyNames }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select:  { company: true, fiscal_year: true, quarter: true },
      distinct: ['company', 'fiscal_year', 'quarter'],
      orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:   { company: { in: companyNames }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
      select:  { company: true, fiscal_year: true, quarter: true },
      distinct: ['company', 'fiscal_year', 'quarter'],
      orderBy: [{ company: 'asc' }, { fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.prowessValueNew.findMany({
      where:  { company: { in: companyNames }, kpi_abbr: { in: abbrs }, source_type: 'C', callId: { startsWith: 'prowess_new_' } },
      select: { company: true, fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
    prisma.prowessValueNew.findMany({
      where:  { company: { in: companyNames }, kpi_abbr: { in: abbrs }, source_type: 'S', callId: { startsWith: 'prowess_new_' } },
      select: { company: true, fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
    }),
  ]);

  const periodsByCoC = _groupByCompany(periodRowsC);
  const periodsByCoS = _groupByCompany(periodRowsS);
  const kpisByCoC    = _groupByCompany(kpiRowsC);
  const kpisByCoS    = _groupByCompany(kpiRowsS);

  const result = {};
  for (const company of companyNames) {
    const periodsC = periodsByCoC.get(company) ?? [];
    const periods  = periodsC.length ? periodsC : (periodsByCoS.get(company) ?? []);
    const rowsC    = kpisByCoC.get(company) ?? [];
    const rowsS    = kpisByCoS.get(company) ?? [];
    const abbrsWithC = new Set(rowsC.map(r => r.kpi_abbr));
    const kpiRows  = [...rowsC, ...rowsS.filter(r => !abbrsWithC.has(r.kpi_abbr))];
    result[company] = _buildResult(abbrs, periods, kpiRows);
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

/**
 * Which source_type ('C' preferred, 'S' fallback for annual; always 'S' for
 * quarterly) fetchAnnualBatch/fetchQuarterlyBatch actually used for `ticker`
 * at `frequency` — a cheap existence check mirroring (not replacing) those
 * fetchers' own internal C-preferred/S-fallback logic. Admin-preview display
 * only, never used in computation — see admin.kpis.service.js#previewKpi.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} ticker
 * @param {'annual'|'quarterly'} frequency
 * @returns {Promise<'C'|'S'|null>} null when the company has no prowess_values_new rows at all for that cadence
 */
async function resolveSourceType(prisma, ticker, frequency) {
  const prowessName = await resolveProwessName(prisma, ticker);
  if (!prowessName) return null;

  const callIdPrefix = frequency === 'quarterly' ? 'prowess_qtr_' : 'prowess_new_';

  if (frequency === 'quarterly') {
    // fetchQuarterlyBatch only ever queries source_type='S' — Prowess has no
    // consolidated quarterly filings — so existence is the only question.
    const row = await prisma.prowessValueNew.findFirst({
      where:  { company: prowessName, source_type: 'S', callId: { startsWith: callIdPrefix } },
      select: { callId: true },
    });
    return row ? 'S' : null;
  }

  const rowC = await prisma.prowessValueNew.findFirst({
    where:  { company: prowessName, source_type: 'C', callId: { startsWith: callIdPrefix } },
    select: { callId: true },
  });
  if (rowC) return 'C';

  const rowS = await prisma.prowessValueNew.findFirst({
    where:  { company: prowessName, source_type: 'S', callId: { startsWith: callIdPrefix } },
    select: { callId: true },
  });
  return rowS ? 'S' : null;
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
  resolveSourceType,
};
