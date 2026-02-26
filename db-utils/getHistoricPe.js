// db-utils/getHistoricPe.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * Map a Date object to a quarter label ("YYYYQN").
 * e.g. 2024-04-15 → "2024Q2"
 */
function dateToQuarterKey(date) {
  const year = date.getFullYear();
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `${year}Q${quarter}`;
}

/**
 * Fetch weekly PE history for a single ticker from the pe_data table,
 * average it into quarterly buckets, and return the last 12 quarters (3 years).
 *
 * @param {string} ticker
 * @returns {Promise<{ ticker, quarterlyPe: Array<{ quarter, avgPe, dataPoints }> }>}
 */
async function fetchTickerPeHistory(ticker) {
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const rows = await prisma.pe_data.findMany({
    where: {
      company: ticker,
      date: { gte: threeYearsAgo },
      pe: { not: null },
    },
    select: { date: true, pe: true },
    orderBy: { date: "asc" },
  });

  // Group weekly rows into quarterly buckets
  const quarterMap = new Map(); // "YYYYQN" → { sum, count }
  for (const row of rows) {
    if (row.pe == null || row.pe <= 0) continue;
    const key = dateToQuarterKey(new Date(row.date));
    if (!quarterMap.has(key)) quarterMap.set(key, { sum: 0, count: 0 });
    const q = quarterMap.get(key);
    q.sum += row.pe;
    q.count += 1;
  }

  // Sort ascending by quarter label, keep last 12
  const quarterlyPe = [...quarterMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([quarter, { sum, count }]) => ({
      quarter,
      avgPe: parseFloat((sum / count).toFixed(2)),
      dataPoints: count,
    }));

  return { ticker, quarterlyPe };
}

/**
 * Fetch quarterly-averaged PE history for multiple tickers in parallel.
 * Failed tickers return { ticker, error } — one failure won't abort the batch.
 *
 * @param {string[]} tickers
 * @returns {Promise<Array<{ ticker, quarterlyPe } | { ticker, error }>>}
 */
async function getHistoricPeForTickers(tickers) {
  const results = await Promise.allSettled(
    tickers.map((ticker) => fetchTickerPeHistory(ticker))
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      ticker: tickers[i],
      error: result.reason?.message ?? "Unknown error",
    };
  });
}

module.exports = { getHistoricPeForTickers };
