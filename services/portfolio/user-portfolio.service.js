'use strict';

const XLSX   = require('xlsx');
const prisma = require('../../config/prisma');
const { enrichHoldings } = require('./market-data.service');

/**
 * Parse a CSV or XLSX buffer into holding records.
 * Expected columns (case-insensitive, spaces normalised to _):
 *   ticker | amount_invested | invested_at
 */
function parsePortfolioBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: null });

  return rows.map((row, i) => {
    const norm = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '_'), v])
    );

    const ticker = String(norm.ticker || '').toUpperCase().trim();
    const amount = parseFloat(norm.amount_invested);
    const raw    = norm.invested_at;
    const date   = raw instanceof Date ? raw : new Date(raw);

    if (!ticker)       { const e = new Error(`Row ${i + 1}: missing ticker`);          e.status = 400; throw e; }
    if (isNaN(amount)) { const e = new Error(`Row ${i + 1}: invalid amount_invested`); e.status = 400; throw e; }
    if (isNaN(date))   { const e = new Error(`Row ${i + 1}: invalid invested_at`);     e.status = 400; throw e; }

    return { ticker, amount_invested: amount, invested_at: date };
  });
}

/**
 * Atomically replace all holdings for a user's portfolio.
 * Creates the UserPortfolio row if it does not exist yet.
 */
async function replaceUserPortfolio(userId, holdingsData) {
  return prisma.$transaction(async (tx) => {
    const portfolio = await tx.userPortfolio.upsert({
      where:  { user_id: userId },
      update: { updated_at: new Date() },
      create: { user_id: userId },
    });

    await tx.holding.deleteMany({ where: { user_portfolio_id: portfolio.id } });

    const created = await tx.holding.createMany({
      data: holdingsData.map(h => ({
        ticker:            h.ticker,
        amount_invested:   h.amount_invested,
        invested_at:       h.invested_at,
        user_portfolio_id: portfolio.id,
      })),
    });

    return { portfolio_id: portfolio.id, holdings_count: created.count };
  });
}

async function getUserPortfolio(userId) {
  const portfolio = await prisma.userPortfolio.findUnique({
    where:   { user_id: userId },
    include: {
      holdings: {
        include: { notes: { orderBy: { created_at: 'desc' } } },
        orderBy: { invested_at: 'desc' },
      },
    },
  });
  if (!portfolio) {
    console.log(`[getUserPortfolio] No portfolio linked for user ${userId} — returning empty state`);
    return { portfolio: null, holdings: [], empty: true };
  }

  const tickers    = [...new Set(portfolio.holdings.map(h => h.ticker))];
  const marketData = await enrichHoldings(tickers);

  return {
    ...portfolio,
    holdings: portfolio.holdings.map(h => {
      const md = marketData[h.ticker] ?? null;
      // Uploaded portfolios only store amount_invested (no share count), so quantity
      // is unknown. current_value is derivable only if we had quantity, so it stays
      // null here — the frontend falls back to amount_invested. market_data still
      // carries live ltp / change_percent for the day-change display.
      return {
        ...h,
        broker:        null,          // uploaded holdings aren't attributed to a broker
        quantity:      null,
        current_value: null,
        market_data:   md,
      };
    }),
  };
}

module.exports = { parsePortfolioBuffer, replaceUserPortfolio, getUserPortfolio };
