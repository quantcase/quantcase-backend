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
 * Populate the user's default "Holdings" journal from real holdings sources
 * (smallcase holdings + user/shadow portfolio holdings), deduped by uppercased ticker.
 * MIRRORS HOLDINGS: newly-held tickers are added with source 'holdings_sync',
 * and tickers no longer held are removed (cascading deletes for any notes/theses).
 *
 * @param {string} userId
 * @returns {Promise<{ journalId: string, added: number, total: number, deleted: number }>}
 */
async function syncHoldingsJournal(userId) {
  const { holdings } = await ensureDefaultJournals(userId);
  const journalId    = holdings.id;

  const [scHoldings, portfolio] = await Promise.all([
    smallcaseHoldingTickers(userId),
    portfolioHoldingTickers(userId),
  ]);

  const wanted = [...new Set(
    [...scHoldings, ...portfolio].map(normTicker),
  )].filter(Boolean);

  let added = 0;
  let deletedCount = 0;

  if (!wanted.length) {
    const del = await prisma.journalTicker.deleteMany({
      where: { journal_id: journalId }
    });
    return { journalId, added: 0, total: 0, deleted: del.count };
  }

  // Delete tickers that are no longer in 'wanted'
  const del = await prisma.journalTicker.deleteMany({
    where: { 
      journal_id: journalId, 
      ticker: { notIn: wanted } 
    }
  });
  deletedCount = del.count;

  // Existing tickers in the holdings journal
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
    added = toAdd.length;
  }

  return { journalId, added, total: wanted.length, deleted: deletedCount };
}

module.exports = { syncHoldingsJournal };
