'use strict';

// Prisma.join — parameterises the IN list in fetchMonthlyCloseBatch's raw query.
const { Prisma } = require('@prisma/client');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// ── Bar aggregation (shared utility) ─────────────────────────────────────────
// rows must be sorted ascending by datetime.

function aggregateBars(rows, interval) {
  if (!rows || rows.length === 0) return [];

  function bucketKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (interval === '1d')  return dt.toISOString().slice(0, 10);
    if (interval === '1wk') {
      const day  = dt.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const mon  = new Date(dt);
      mon.setDate(dt.getDate() + diff);
      return mon.toISOString().slice(0, 10);
    }
    if (interval === '1mo') return dt.toISOString().slice(0, 7);
    return dt.toISOString().slice(0, 10);
  }

  const buckets = new Map();
  for (const r of rows) {
    const closeVal = parseFloat(r.close);
    if (!isFinite(closeVal)) continue;
    const dt       = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const key      = bucketKey(dt);
    const highVal  = isFinite(parseFloat(r.high))  ? parseFloat(r.high)  : closeVal;
    const lowVal   = isFinite(parseFloat(r.low))   ? parseFloat(r.low)   : closeVal;
    const openVal  = isFinite(parseFloat(r.open))  ? parseFloat(r.open)  : closeVal;
    // marketCap tracks close (last value in the bucket wins) and is only present when the
    // caller selected market_cap_cr; consumers that don't need it just ignore it.
    const mcapVal = isFinite(parseFloat(r.market_cap_cr)) ? parseFloat(r.market_cap_cr) : null;
    if (!buckets.has(key)) {
      buckets.set(key, { date: key, open: openVal, high: highVal, low: lowVal, close: closeVal, volume: Number(r.volume ?? 0), marketCap: mcapVal });
    } else {
      const b  = buckets.get(key);
      b.high   = Math.max(b.high, highVal);
      b.low    = Math.min(b.low,  lowVal);
      b.close  = closeVal;
      b.volume += Number(r.volume ?? 0);
      b.marketCap = mcapVal;
    }
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// nse_index uses Decimal columns — convert before calling aggregateBars.
function aggregateIndexBars(rows, interval) {
  if (!rows || rows.length === 0) return [];
  return aggregateBars(
    rows.map(r => ({
      datetime: r.datetime,
      open:     r.open   != null ? parseFloat(r.open)   : null,
      high:     r.high   != null ? parseFloat(r.high)   : null,
      low:      r.low    != null ? parseFloat(r.low)    : null,
      close:    r.close  != null ? parseFloat(r.close)  : null,
      volume:   r.volume != null ? Number(r.volume)     : 0,
    })),
    interval,
  );
}

// ── nse_equity_new fetchers ───────────────────────────────────────────────────

/**
 * Fetch OHLCV bars for a symbol from nse_equity_new.
 * Returns daily / weekly / monthly bars plus a synthetic quote, ATH/ATL and 52w dates.
 * Mirrors the shape that technicalAnalysis.fetchMarketData() previously built internally.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @param {{ since?: Date }} [opts]  defaults to 3 years back
 */
async function fetchOhlcvBars(prisma, symbol, { since } = {}) {
  const now       = Date.now();
  const threeYrsAgo = since ?? new Date(now - 3 * ONE_YEAR_MS);
  const oneYearAgo  = new Date(now - ONE_YEAR_MS);
  const twoYrsAgo   = new Date(now - 2 * ONE_YEAR_MS);

  const [allRows, athAtlRows] = await Promise.all([
    prisma.nse_equity_new.findMany({
      where:   { symbol, datetime: { gte: threeYrsAgo } },
      orderBy: { datetime: 'asc' },
      select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true },
    }),
    prisma.$queryRaw`
      SELECT
        MAX(high)::float AS ath,
        MIN(low)::float  AS atl,
        (SELECT datetime FROM nse_equity_new WHERE symbol = ${symbol} AND high = (SELECT MAX(high) FROM nse_equity_new WHERE symbol = ${symbol}) ORDER BY datetime DESC LIMIT 1) AS ath_date,
        (SELECT datetime FROM nse_equity_new WHERE symbol = ${symbol} AND low  = (SELECT MIN(low)  FROM nse_equity_new WHERE symbol = ${symbol}) ORDER BY datetime DESC LIMIT 1) AS atl_date
      FROM nse_equity_new
      WHERE symbol = ${symbol}
    `,
  ]);

  const dailyRaw   = allRows.filter(r => new Date(r.datetime) >= oneYearAgo);
  const weeklyRaw  = allRows.filter(r => new Date(r.datetime) >= twoYrsAgo);
  const monthlyRaw = allRows;

  const dailyBars   = aggregateBars(dailyRaw,   '1d');
  const weeklyBars  = aggregateBars(weeklyRaw,  '1wk');
  const monthlyBars = aggregateBars(monthlyRaw, '1mo');

  // Full 3-year daily series (not sliced to 1y like dailyBars). Needed by callers
  // computing long-warmup stats — e.g. SMA_200 touch counts over the last 200 days
  // require ~400 bars, which the 1-year dailyBars window cannot supply.
  const dailyBarsFull = aggregateBars(allRows, '1d');

  const latest = dailyBars.at(-1) ?? null;
  const prev   = dailyBars.length > 1 ? dailyBars.at(-2) : null;
  const quote  = latest ? {
    regularMarketPrice:          latest.close,
    regularMarketPreviousClose:  prev?.close ?? latest.open,
    regularMarketOpen:           latest.open,
    regularMarketDayHigh:        latest.high,
    regularMarketDayLow:         latest.low,
    regularMarketVolume:         latest.volume,
    fiftyTwoWeekHigh:            dailyBars.length ? Math.max(...dailyBars.map(b => b.high)) : null,
    fiftyTwoWeekLow:             dailyBars.length ? Math.min(...dailyBars.map(b => b.low))  : null,
  } : null;

  const athAtl = athAtlRows[0] ?? {};
  const allTimeHigh     = athAtl.ath     != null ? parseFloat(athAtl.ath)     : null;
  const allTimeLow      = athAtl.atl     != null ? parseFloat(athAtl.atl)     : null;
  const allTimeHighDate = athAtl.ath_date ? new Date(athAtl.ath_date).toISOString().slice(0, 10) : null;
  const allTimeLowDate  = athAtl.atl_date ? new Date(athAtl.atl_date).toISOString().slice(0, 10) : null;

  let high52wDate = null, low52wDate = null;
  if (dailyBars.length) {
    high52wDate = dailyBars.reduce((a, b) => b.high > a.high ? b : a).date;
    low52wDate  = dailyBars.reduce((a, b) => b.low  < a.low  ? b : a).date;
  }

  return { dailyBars, dailyBarsFull, weeklyBars, monthlyBars, quote, nextEarningsDate: null, allTimeHigh, allTimeLow, allTimeHighDate, allTimeLowDate, high52wDate, low52wDate };
}

/**
 * Full unsliced daily OHLCV for the Wyckoff engine.
 *
 * Unlike fetchOhlcvBars this applies no `since` window — the engine wants every bar it
 * can get for ATH/ATL and the long return horizons, and does its own era selection
 * (lib/wyckoff.js#selectContiguousDailyEra) to discard the pre-2025 stretch where the
 * table holds daily bars sampled weekly rather than true daily bars.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * market_cap_cr rides along so wyckoff.backAdjustSplits() can tell a bonus or split from a
 * genuine crash — market cap is continuous across the former and collapses on the latter.
 *
 * @returns {Promise<Array<{date,open,high,low,close,volume,marketCap}>>} ascending, deduped by date
 */
async function fetchWyckoffBars(prisma, symbol) {
  const rows = await prisma.nse_equity_new.findMany({
    where:   { symbol },
    orderBy: { datetime: 'asc' },
    select:  { datetime: true, open: true, high: true, low: true, close: true, volume: true, market_cap_cr: true },
  });
  // aggregateBars('1d') also dedupes should the table ever gain two rows for one date —
  // getPrices maps rows straight through and would not.
  return aggregateBars(rows.filter(r => r.close != null), '1d');
}

/**
 * Latest single-row snapshot: close, pe, eps, market_cap_cr, datetime.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @returns {Promise<{ close, pe, eps, market_cap_cr, datetime }|null>}
 */
async function fetchMarketSnapshot(prisma, symbol) {
  const row = await prisma.nse_equity_new.findFirst({
    where:   { symbol, close: { not: null } },
    orderBy: { datetime: 'desc' },
    select:  { close: true, pe: true, eps: true, market_cap_cr: true, datetime: true },
  });
  if (!row) return null;
  return {
    close:         row.close         != null ? parseFloat(row.close)         : null,
    pe:            row.pe            != null ? parseFloat(row.pe)            : null,
    eps:           row.eps           != null ? parseFloat(row.eps)           : null,
    market_cap_cr: row.market_cap_cr != null ? parseFloat(row.market_cap_cr) : null,
    datetime:      row.datetime instanceof Date ? row.datetime.toISOString().slice(0, 10) : null,
  };
}

/**
 * Bulk latest snapshot for multiple tickers.
 * Returns a plain object: { [SYMBOL]: { close, prevClose, pe, eps, market_cap_cr } }
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} symbols
 */
async function fetchMarketSnapshots(prisma, symbols) {
  if (!symbols.length) return {};
  const rows = await prisma.$queryRaw`
    SELECT symbol, close::float, pe::float, eps::float, market_cap_cr::float, datetime
    FROM (
      SELECT symbol, close, pe, eps, market_cap_cr, datetime,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY datetime DESC) AS rn
      FROM nse_equity_new
      WHERE symbol = ANY(${symbols}) AND close IS NOT NULL
    ) sub
    WHERE rn <= 2
    ORDER BY symbol, rn
  `;

  const map = {};
  for (const row of rows) {
    const sym = row.symbol.toUpperCase();
    if (!map[sym]) map[sym] = { close: null, prevClose: null, pe: null, eps: null, market_cap_cr: null };
    const snap = map[sym];
    if (snap.close === null) {
      snap.close         = row.close         != null ? parseFloat(row.close)         : null;
      snap.pe            = row.pe            != null ? parseFloat(row.pe)            : null;
      snap.eps           = row.eps           != null ? parseFloat(row.eps)           : null;
      snap.market_cap_cr = row.market_cap_cr != null ? parseFloat(row.market_cap_cr) : null;
    } else {
      snap.prevClose = row.close != null ? parseFloat(row.close) : null;
    }
  }
  return map;
}

/**
 * PE time-series from nse_equity_new (replaces pe_data table).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @param {{ months?: number, since?: Date }} [opts]
 * @returns {Promise<Array<{ date: string, pe: number }>>}
 */
async function fetchPeTimeSeries(prisma, symbol, { months, since } = {}) {
  const cutoff = since ?? (months != null
    ? new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000)
    : null);

  const rows = await prisma.nse_equity_new.findMany({
    where: {
      symbol,
      pe: { not: null },
      ...(cutoff ? { datetime: { gte: cutoff } } : {}),
    },
    orderBy: { datetime: 'asc' },
    select:  { datetime: true, pe: true },
  });

  return rows.map(r => ({
    date: r.datetime instanceof Date ? r.datetime.toISOString().slice(0, 10) : String(r.datetime),
    pe:   r.pe != null ? parseFloat(r.pe) : null,
  }));
}

// Which nse_equity_new column backs each daily-frequency Kpi abbr this
// fetcher understands. Extend alongside resolutionContext.js's
// DAILY_ABBR_TO_SNAPSHOT_FIELD (current-value map) when adding a new one —
// the two maps intentionally mirror each other.
const DAILY_SERIES_FIELDS = { PRICE: 'close', PE_DAILY: 'pe', MCAP_SNAPSHOT: 'market_cap_cr' };

// How to collapse this daily abbr's native series into a coarser bucket
// (calendar quarter/year) when something asks for it at 'quarterly' or
// 'annual' -- application-level policy, not admin-configurable: every abbr
// in DAILY_SERIES_FIELDS is expected to have an entry here (resolutionContext
// .js treats a missing entry as "can't be resampled", so add one whenever a
// new daily abbr is added above). All three today are point-in-time
// snapshots (a price/ratio "as of" a date), so 'latest' -- the most recent
// value within the bucket -- is the only mode that makes sense; 'average'
// exists for a future abbr where a period mean would be more meaningful.
const DAILY_RESAMPLE_MODE = { PRICE: 'latest', PE_DAILY: 'latest', MCAP_SNAPSHOT: 'latest' };

/**
 * Buckets an ascending {value, date}[] series into calendar quarters or
 * years and reduces each bucket to one point via `mode` -- the mechanism
 * that lets a genuinely-daily abbr (PRICE) serve a 'quarterly'/'annual'
 * request with the exact same CAGR/AVG/SUM formula grammar every annual
 * Kpi already uses, no bespoke date-anchoring logic. Calendar-based (not
 * fiscal-year-aligned) -- stock price has no fiscal year of its own, and
 * this mirrors how the old windowedStockCagr bucketed by calendar month.
 *
 * @param {Array<{value: number|null, date: string}>} points
 * @param {'quarterly'|'annual'} freq
 * @param {'average'|'latest'} mode
 * @returns {Array<{value: number|null, date: string}>} one point per bucket, ascending
 */
function resampleToFrequency(points, freq, mode) {
  const buckets = new Map(); // bucketKey -> points in that bucket, ascending
  for (const p of points) {
    if (p.value == null) continue;
    const d = new Date(p.date);
    const year = d.getUTCFullYear();
    const key = freq === 'annual' ? `${year}` : `${year}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  return [...buckets.keys()].sort().map((key) => {
    const pts = buckets.get(key);
    const value = mode === 'average'
      ? pts.reduce((s, p) => s + p.value, 0) / pts.length
      : pts[pts.length - 1].value; // 'latest'
    return { value, date: pts[pts.length - 1].date };
  });
}

/**
 * Same idea as resampleToFrequency, but bucketed against a real, explicit
 * list of periods (each with its own [start_date, end_date]) instead of
 * computed calendar boundaries -- what makes the resampled series land on
 * the *company's actual fiscal quarters* (e.g. Apr-Jun, not calendar Q2)
 * instead of drifting out of alignment with it. This is what lets a
 * daily-native abbr (PRICE/MCAP_SNAPSHOT) sit correctly, index-for-index,
 * alongside genuine Prowess fundamentals in the same seriesMap that
 * _resolveAtIndex walks -- no changes needed there, since the map it reads
 * now just has real values for these abbrs instead of nothing.
 *
 * @param {Array<{value: number|null, date: string}>} points — ascending daily points
 * @param {Array<{fiscal_year: string, quarter: string|null, start_date: string|null, end_date: string|null}>} periods — ascending, from fetchAnnualBatch/fetchQuarterlyBatch's period list
 * @param {'average'|'latest'} mode
 * @returns {Array<{value: number|null, fiscal_year: string, quarter: string|null}>} one entry per period, same order/length as `periods`
 */
function resampleToPeriods(points, periods, mode) {
  const valid = points.filter((p) => p.value != null);
  return periods.map((period) => {
    if (!period.start_date || !period.end_date) {
      return { value: null, fiscal_year: period.fiscal_year, quarter: period.quarter };
    }
    const start = new Date(period.start_date);
    const end   = new Date(period.end_date);
    const inRange = valid.filter((p) => {
      const d = new Date(p.date);
      return d >= start && d <= end;
    });
    if (!inRange.length) return { value: null, fiscal_year: period.fiscal_year, quarter: period.quarter };
    const value = mode === 'average'
      ? inRange.reduce((s, p) => s + p.value, 0) / inRange.length
      : inRange[inRange.length - 1].value; // 'latest'
    return { value, fiscal_year: period.fiscal_year, quarter: period.quarter };
  });
}

/**
 * Full daily history of one nse_equity_new column for one symbol, oldest →
 * newest — the generic series-fetching counterpart to fetchMarketSnapshot's
 * single-latest-row read. Mirrors fetchPeTimeSeries's query shape exactly,
 * parameterized over which column to pull.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @param {string} abbr - a key of DAILY_SERIES_FIELDS
 * @returns {Promise<Array<{ value: number|null, date: string }>>}
 */
async function fetchDailySeries(prisma, symbol, abbr) {
  const field = DAILY_SERIES_FIELDS[abbr];
  if (!field) return [];

  const rows = await prisma.nse_equity_new.findMany({
    where:   { symbol, [field]: { not: null } },
    orderBy: { datetime: 'asc' },
    select:  { datetime: true, [field]: true },
  });

  return rows.map(r => ({
    value: r[field] != null ? parseFloat(r[field]) : null,
    date:  r.datetime instanceof Date ? r.datetime.toISOString().slice(0, 10) : String(r.datetime),
  }));
}

/**
 * All three daily-frequency series (PRICE/PE_DAILY/MCAP_SNAPSHOT) for one
 * symbol in a single query — nse_equity_new stores close/pe/market_cap_cr on
 * the same row per day, so one bulk read serves every daily abbr at once,
 * same "one bulk fetch per frequency" shape fetchAnnualBatch/fetchQuarterlyBatch
 * already use for Prowess data. Every series is padded to the same
 * date-indexed length (null where that day's field is missing), so indices
 * line up across abbrs the same way padded quarterly/annual series already do.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @returns {Promise<{ PRICE: Array<{value,date}>, PE_DAILY: Array<{value,date}>, MCAP_SNAPSHOT: Array<{value,date}> }>}
 */
async function fetchAllDailySeries(prisma, symbol) {
  const rows = await prisma.nse_equity_new.findMany({
    where:   { symbol },
    orderBy: { datetime: 'asc' },
    select:  { datetime: true, close: true, pe: true, market_cap_cr: true },
  });

  const toPoints = (field) => rows.map(r => ({
    value: r[field] != null ? parseFloat(r[field]) : null,
    date:  r.datetime instanceof Date ? r.datetime.toISOString().slice(0, 10) : String(r.datetime),
  }));

  return {
    PRICE:         toPoints('close'),
    PE_DAILY:      toPoints('pe'),
    MCAP_SNAPSHOT: toPoints('market_cap_cr'),
  };
}

/**
 * Bulk version of fetchPeTimeSeries — one query for many symbols instead of one
 * query per symbol. Built for screeners scanning hundreds of candidates (see
 * controllers/baskets.controller.js).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} symbols
 * @param {{ months?: number, since?: Date }} [opts]
 * @returns {Promise<Object<string, Array<{ date: string, pe: number }>>>}  keyed by symbol
 */
async function fetchPeTimeSeriesBatch(prisma, symbols, { months, since } = {}) {
  if (!symbols.length) return {};
  const cutoff = since ?? (months != null
    ? new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000)
    : null);

  const rows = await prisma.nse_equity_new.findMany({
    where: {
      symbol: { in: symbols },
      pe: { not: null },
      ...(cutoff ? { datetime: { gte: cutoff } } : {}),
    },
    orderBy: [{ symbol: 'asc' }, { datetime: 'asc' }],
    select:  { symbol: true, datetime: true, pe: true },
  });

  const result = {};
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    (result[sym] ??= []).push({
      date: r.datetime instanceof Date ? r.datetime.toISOString().slice(0, 10) : String(r.datetime),
      pe:   r.pe != null ? parseFloat(r.pe) : null,
    });
  }
  return result;
}

/**
 * Monthly-aggregated close series (for stock-price CAGR and charts).
 * Uses DATE_TRUNC on the Date column — returns month buckets.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @param {{ since: Date }} opts
 * @returns {Promise<Array<{ month: Date, close: number }>>}
 */
async function fetchMonthlyClose(prisma, symbol, { since }) {
  const rows = await prisma.$queryRaw`
    SELECT DATE_TRUNC('month', datetime) AS month, AVG(close)::float AS close
    FROM nse_equity_new
    WHERE symbol = ${symbol} AND datetime >= ${since}
    GROUP BY DATE_TRUNC('month', datetime)
    ORDER BY month ASC
  `;
  return rows;
}

/**
 * Monthly-aggregated close series for many symbols in one round-trip.
 * Same shape as fetchMonthlyClose, keyed by symbol — prefer this when fetching
 * more than one ticker, so a wide portfolio costs one query rather than N
 * concurrent aggregates over nse_equity_new (~1.2M rows).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} symbols
 * @param {{ since: Date }} opts
 * @returns {Promise<Object<string, Array<{ month: Date, close: number }>>>}  keyed by symbol
 */
async function fetchMonthlyCloseBatch(prisma, symbols, { since }) {
  if (!symbols.length) return {};
  // symbol is stored upper-case; normalise so callers can pass either case and
  // match the upper-cased keys this returns.
  const upper = [...new Set(symbols.map(s => s.toUpperCase()))];

  const rows = await prisma.$queryRaw`
    SELECT symbol, DATE_TRUNC('month', datetime) AS month, AVG(close)::float AS close
    FROM nse_equity_new
    WHERE symbol IN (${Prisma.join(upper)}) AND datetime >= ${since}
    GROUP BY symbol, DATE_TRUNC('month', datetime)
    ORDER BY symbol ASC, month ASC
  `;

  const result = {};
  for (const r of rows) {
    (result[r.symbol.toUpperCase()] ??= []).push({ month: r.month, close: r.close });
  }
  return result;
}

/**
 * Monthly OHLCV + volume (for price chart group in prowess/financials views).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} symbol
 * @param {{ since: Date }} opts
 */
async function fetchMonthlyOhlcv(prisma, symbol, { since }) {
  const rows = await prisma.$queryRaw`
    SELECT DATE_TRUNC('month', datetime) AS month,
           AVG(close)::float  AS close,
           SUM(volume)::float AS volume
    FROM nse_equity_new
    WHERE symbol = ${symbol} AND datetime >= ${since}
    GROUP BY DATE_TRUNC('month', datetime)
    ORDER BY month ASC
  `;
  return rows;
}

// ── nse_index fetchers ────────────────────────────────────────────────────────

/**
 * Fetch OHLCV bars for an index sector from nse_index.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} sector
 * @param {{ since?: Date }} [opts]
 */
async function fetchIndexBars(prisma, sector, { since } = {}) {
  const cutoff = since ?? new Date(Date.now() - 3 * ONE_YEAR_MS);
  const rows = await prisma.nse_index.findMany({
    where:   { sector, datetime: { gte: cutoff } },
    orderBy: { datetime: 'asc' },
  });
  return {
    daily:   aggregateIndexBars(rows.filter(r => new Date(r.datetime) >= new Date(Date.now() - ONE_YEAR_MS)), '1d'),
    weekly:  aggregateIndexBars(rows.filter(r => new Date(r.datetime) >= new Date(Date.now() - 2 * ONE_YEAR_MS)), '1wk'),
    monthly: aggregateIndexBars(rows, '1mo'),
  };
}

module.exports = {
  aggregateBars,
  aggregateIndexBars,
  DAILY_RESAMPLE_MODE,
  resampleToFrequency,
  resampleToPeriods,
  fetchOhlcvBars,
  fetchWyckoffBars,
  fetchMarketSnapshot,
  fetchMarketSnapshots,
  fetchDailySeries,
  fetchAllDailySeries,
  DAILY_SERIES_FIELDS,
  fetchPeTimeSeries,
  fetchPeTimeSeriesBatch,
  fetchMonthlyClose,
  fetchMonthlyCloseBatch,
  fetchMonthlyOhlcv,
  fetchIndexBars,
};
