'use strict';

const prisma = require('../../config/prisma');

/**
 * Compute valuation score for every ticker as the own-history P/E percentile,
 * inverted so that a lower P/E → higher score (better value).
 *
 * Score = 100 - (percentile of current P/E within the ticker's 5-year P/E history)
 *
 * @param {string[]} tickers
 * @param {string}   asOfDate  'YYYY-MM-DD'
 * @returns {Promise<Map<string, number|null>>}   ticker → score 0–100 or null
 */
async function computeValuation(tickers, asOfDate) {
  const fiveYearsAgo = new Date(new Date(asOfDate).getTime() - 5 * 365 * 24 * 60 * 60 * 1000);

  const peRows = await prisma.pe_data.findMany({
    where:   { company: { in: tickers }, date: { gte: fiveYearsAgo, lte: new Date(asOfDate) } },
    orderBy: { date: 'asc' },
    select:  { company: true, pe: true },
  });

  // Collect history per ticker
  const byTicker = new Map();
  for (const r of peRows) {
    if (!byTicker.has(r.company)) byTicker.set(r.company, []);
    const v = r.pe != null ? parseFloat(r.pe.toString()) : null;
    if (v != null && isFinite(v) && v > 0) byTicker.get(r.company).push(v);
  }

  const result = new Map();
  for (const ticker of tickers) {
    const history = byTicker.get(ticker);
    if (!history || history.length < 4) { result.set(ticker, null); continue; }

    const current    = history.at(-1);
    const sorted     = [...history].sort((a, b) => a - b);
    const rank       = sorted.findIndex(v => v >= current);
    const percentile = (rank / (sorted.length - 1)) * 100;
    result.set(ticker, Math.round((100 - percentile) * 10) / 10);
  }

  const covered = [...result.values()].filter(v => v != null).length;
  console.log(`[IIT] Valuation: ${covered}/${tickers.length} tickers have P/E history`);
  return result;
}

module.exports = { computeValuation };
