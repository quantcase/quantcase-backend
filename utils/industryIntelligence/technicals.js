'use strict';

const prisma = require('../../config/prisma');

const NIFTY_INDEX    = 'NIFTY 50';
const LOOKBACK_WEEKS = { '3m': 13, '6m': 26, '12m': 52 };

// Aggregate daily rows (sorted asc) into weekly bars keyed by Monday ISO date.
// Returns [{week: 'YYYY-MM-DD', close: number}] sorted ascending.
function toWeeklyBars(dailyRows) {
  const buckets = new Map();
  for (const r of dailyRows) {
    const d   = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const key = mon.toISOString().slice(0, 10);
    // Last close of the week wins (rows are sorted asc so later rows overwrite)
    buckets.set(key, parseFloat(r.close));
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, close]) => ({ week, close }));
}

function simpleSma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// Percentage return between closes[-(lookback+1)] and closes[-1].
function periodReturn(closes, lookback) {
  if (closes.length <= lookback) return null;
  const past = closes.at(-(lookback + 1));
  const now  = closes.at(-1);
  return past && past !== 0 ? (now - past) / past * 100 : null;
}

/**
 * Batch-fetch price data for all tickers up to asOfDate and compute:
 *   above_20w  — 1 if latest close > 20-week SMA, 0 otherwise
 *   rel3m/6m/12m — return relative to NIFTY 50 over 3/6/12 months
 *
 * @param {string[]} tickers
 * @param {string}   asOfDate  'YYYY-MM-DD'
 * @returns {Promise<Map<string, {above_20w: 0|1|null, rel3m: number|null, rel6m: number|null, rel12m: number|null}>>}
 */
async function computeTechnicals(tickers, asOfDate) {
  const asOf       = new Date(asOfDate);
  const oneYearAgo = new Date(asOf.getTime() - 366 * 24 * 60 * 60 * 1000);

  const [equityRows, niftyRows] = await Promise.all([
    prisma.nse_equity.findMany({
      where:   { symbol: { in: tickers }, datetime: { gte: oneYearAgo, lte: asOf } },
      orderBy: { datetime: 'asc' },
      select:  { symbol: true, datetime: true, close: true },
    }),
    prisma.nse_index.findMany({
      where:   { sector: NIFTY_INDEX, datetime: { gte: oneYearAgo, lte: asOf } },
      orderBy: { datetime: 'asc' },
      select:  { datetime: true, close: true },
    }),
  ]);

  // NIFTY 50 benchmark returns
  const niftyBars   = toWeeklyBars(niftyRows.map(r => ({ datetime: r.datetime, close: r.close?.toString() })));
  const niftyCloses = niftyBars.map(b => b.close);
  const niftyRet    = (w) => periodReturn(niftyCloses, w);

  // Group equity rows by symbol
  const bySymbol = new Map();
  for (const r of equityRows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }

  const result = new Map();
  for (const ticker of tickers) {
    const daily = bySymbol.get(ticker);
    if (!daily?.length) { result.set(ticker, null); continue; }

    const bars   = toWeeklyBars(daily);
    const closes = bars.map(b => b.close);
    const last   = closes.at(-1);

    const sma20w    = simpleSma(closes, 20);
    const above_20w = sma20w != null ? (last > sma20w ? 1 : 0) : null;

    const rel = (w) => {
      const sr = periodReturn(closes, w);
      const nr = niftyRet(w);
      return sr != null && nr != null ? sr - nr : null;
    };

    result.set(ticker, {
      above_20w,
      rel3m:  rel(LOOKBACK_WEEKS['3m']),
      rel6m:  rel(LOOKBACK_WEEKS['6m']),
      rel12m: rel(LOOKBACK_WEEKS['12m']),
    });
  }

  const covered = [...result.values()].filter(v => v != null).length;
  console.log(`[IIT] Technicals: ${covered}/${tickers.length} tickers have price data`);
  return result;
}

module.exports = { computeTechnicals };
