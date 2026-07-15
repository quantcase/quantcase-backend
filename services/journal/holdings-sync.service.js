'use strict';

const prisma                    = require('../../config/prisma');
const { ensureDefaultJournals } = require('./journal.service');

function normTicker(t) {
  return String(t ?? '').toUpperCase().trim();
}

// ─── Ticker gatherers ─────────────────────────────────────────────────────────
// Each gatherer is wrapped so a missing connection / empty source yields [] and
// never throws — the holdings journal must populate from whatever sources exist.

async function smallcaseHoldingTickers(userId) {
  try {
    const rows = await prisma.smallcaseHolding.findMany({
      where:  { smallcase_user: { user_id: userId } },
      select: { ticker: true },
    });
    return rows.map(r => r.ticker);
  } catch (err) {
    console.error('[syncHoldingsJournal] smallcase holdings gather failed:', err.message);
    return [];
  }
}

async function smallcaseBasketTickers(userId) {
  try {
    const rows = await prisma.smallcaseBasket.findMany({
      where:  { smallcase_user: { user_id: userId } },
      select: { constituents: true },
    });
    const tickers = [];
    for (const row of rows) {
      const constituents = Array.isArray(row.constituents) ? row.constituents : [];
      for (const c of constituents) {
        if (c && c.ticker) tickers.push(c.ticker);
      }
    }
    return tickers;
  } catch (err) {
    console.error('[syncHoldingsJournal] smallcase basket gather failed:', err.message);
    return [];
  }
}

async function portfolioHoldingTickers(userId) {
  try {
    const [userPort, shadowPort] = await Promise.all([
      prisma.userPortfolio.findUnique({
        where:   { user_id: userId },
        include: { holdings: { select: { ticker: true } } },
      }),
      prisma.shadowPortfolio.findUnique({
        where:   { user_id: userId },
        include: { holdings: { select: { ticker: true } } },
      }),
    ]);
    return [
      ...(userPort?.holdings   ?? []).map(h => h.ticker),
      ...(shadowPort?.holdings ?? []).map(h => h.ticker),
    ];
  } catch (err) {
    console.error('[syncHoldingsJournal] portfolio holdings gather failed:', err.message);
    return [];
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Populate the user's default "Holdings" journal from ALL holdings sources
 * (smallcase holdings + smallcase basket constituents + user/shadow portfolio
 * holdings), deduped by uppercased ticker. ADD-ONLY: newly-held tickers are added
 * with source 'holdings_sync'; existing tickers (and all their notes/theses) are
 * never touched, and exited tickers are never removed.
 *
 * @param {string} userId
 * @returns {Promise<{ journalId: string, added: number, total: number }>}
 */
async function syncHoldingsJournal(userId) {
  const { holdings } = await ensureDefaultJournals(userId);
  const journalId    = holdings.id;

  const [scHoldings, scBaskets, portfolio] = await Promise.all([
    smallcaseHoldingTickers(userId),
    smallcaseBasketTickers(userId),
    portfolioHoldingTickers(userId),
  ]);

  const wanted = [...new Set(
    [...scHoldings, ...scBaskets, ...portfolio].map(normTicker),
  )].filter(Boolean);

  if (!wanted.length) return { journalId, added: 0, total: 0 };

  // Existing tickers in the holdings journal — only add the ones not already there.
  const existing = await prisma.journalTicker.findMany({
    where:  { journal_id: journalId, ticker: { in: wanted } },
    select: { ticker: true },
  });
  const existingSet = new Set(existing.map(r => r.ticker));

  const toAdd = wanted.filter(t => !existingSet.has(t));
  if (toAdd.length) {
    await prisma.journalTicker.createMany({
      data: toAdd.map(ticker => ({ journal_id: journalId, ticker, source: 'holdings_sync' })),
      skipDuplicates: true,
    });
  }

  return { journalId, added: toAdd.length, total: wanted.length };
}

module.exports = { syncHoldingsJournal };
