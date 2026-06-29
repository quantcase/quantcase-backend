// services/db/historicPe.db.js

const prisma = require('../../config/prisma');

function dateToQuarterKey(date) {
  const year    = date.getFullYear();
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `${year}Q${quarter}`;
}

/**
 * Fetch PE history for a single ticker from nse_equity_new,
 * average it into quarterly buckets, and return the last 12 quarters (3 years).
 */
async function fetchTickerPeHistory(ticker) {
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const rows = await prisma.nse_equity_new.findMany({
    where: {
      symbol:   ticker,
      datetime: { gte: threeYearsAgo },
      pe:       { not: null },
    },
    select:  { datetime: true, pe: true },
    orderBy: { datetime: 'asc' },
  });

  const quarterMap = new Map();
  for (const row of rows) {
    if (row.pe == null || row.pe <= 0) continue;
    const key = dateToQuarterKey(new Date(row.datetime));
    if (!quarterMap.has(key)) quarterMap.set(key, { sum: 0, count: 0 });
    const q = quarterMap.get(key);
    q.sum   += Number(row.pe);
    q.count += 1;
  }

  const quarterlyPe = [...quarterMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([quarter, { sum, count }]) => ({
      quarter,
      avgPe:      parseFloat((sum / count).toFixed(2)),
      dataPoints: count,
    }));

  return { ticker, quarterlyPe };
}

/**
 * Fetch quarterly-averaged PE history for multiple tickers in parallel.
 * Failed tickers return { ticker, error }.
 */
async function getHistoricPeForTickers(tickers) {
  const results = await Promise.allSettled(
    tickers.map(ticker => fetchTickerPeHistory(ticker))
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    return { ticker: tickers[i], error: result.reason?.message ?? 'Unknown error' };
  });
}

module.exports = { getHistoricPeForTickers };
