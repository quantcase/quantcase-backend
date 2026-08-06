'use strict';

const prisma             = require('../../config/prisma');
const { enrichHoldings } = require('../portfolio/market-data.service');
const {
  VALID_SUB_FACTORS,
  resolveSubFactorSlug,
  fetchLensScoreMap,
  buildSnapshot,
  evaluateHealth,
} = require('./journal.health');

// ─── Error helpers ────────────────────────────────────────────────────────────

function notFound(msg, code) {
  const e = new Error(msg);
  e.status = 404;
  e.code   = code;
  return e;
}

function badRequest(msg, code) {
  const e = new Error(msg);
  e.status = 400;
  e.code   = code;
  return e;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normTicker(t) {
  return String(t ?? '').toUpperCase().trim();
}

// ─── Ownership guards ─────────────────────────────────────────────────────────

/**
 * Verify a journal belongs to the user and return it. 404 (not 403) on mismatch
 * so we never leak the existence of another user's journal.
 */
async function assertJournalOwnership(userId, journalId) {
  const journal = await prisma.journal.findFirst({ where: { id: journalId, user_id: userId } });
  if (!journal) throw notFound('Journal not found', 'JOURNAL_NOT_FOUND');
  return journal;
}

/**
 * Verify a journal entry belongs to the user (via journal_ticker → journal → user)
 * and return it (with its ticker + health included).
 */
async function assertEntryOwnership(userId, entryId) {
  const entry = await prisma.journalEntry.findFirst({
    where:   { id: entryId, journal_ticker: { journal: { user_id: userId } } },
    include: { health: true, journal_ticker: true },
  });
  if (!entry) throw notFound('Journal entry not found', 'ENTRY_NOT_FOUND');
  return entry;
}

// ─── Entry shaping ────────────────────────────────────────────────────────────

function entryType(entry) {
  return entry.dimension ? 'thesis' : 'note';
}

function shapeEntry(entry) {
  return {
    id:           entry.id,
    type:         entryType(entry),
    noteText:     entry.note_text ?? null,
    dimension:    entry.dimension ?? null,
    subFactors:   Array.isArray(entry.sub_factors) ? entry.sub_factors : null,
    thesis:       entry.thesis ?? null,
    conviction:   entry.conviction ?? null,
    thesisHealth: entry.health?.thesis_health ?? (entry.dimension ? 'none' : null),
    aiNudge:      entry.health?.ai_nudge ?? null,
    createdAt:    entry.created_at,
    updatedAt:    entry.updated_at,
  };
}

function shapeJournal(journal, tickerCount) {
  return {
    id:         journal.id,
    name:       journal.name,
    kind:       journal.kind,
    isDefault:  journal.is_default,
    tickerCount: tickerCount ?? journal.tickers?.length ?? 0,
    createdAt:  journal.created_at,
    updatedAt:  journal.updated_at,
  };
}

// A holdings sync inserts its tickers via createMany, so they all share one
// added_at — `added_at desc` alone leaves the order undefined and rows shuffle
// between reads. Ticker breaks the tie so paging/refreshes are stable.
const TICKER_ORDER = [{ added_at: 'desc' }, { ticker: 'asc' }];

/**
 * Shape a JournalTicker (loaded with `entries: { include: { health } }`, newest
 * first) into the API ticker object. Shared by the journal detail endpoint and the
 * expanded journal list so both surfaces stay identical.
 *
 * @param {object} t            JournalTicker with `entries` included
 * @param {object} [md]         enrichHoldings() entry for this ticker
 * @param {boolean} [withEntries] embed the full `entries` array
 */
function shapeJournalTicker(t, md = {}, withEntries = false) {
  const entries      = t.entries ?? [];
  // Latest thesis health = health of the most-recent thesis-typed entry.
  const latestThesis = entries.find(e => e.dimension);

  return {
    ticker:     t.ticker,
    source:     t.source,
    addedAt:    t.added_at,
    entryCount: entries.length,
    market: {
      ltp:           md?.ltp ?? null,
      change:        md?.change ?? null,
      changePercent: md?.change_percent ?? null,
      qcScore:       md?.qc_score ?? null,
      conviction:    md?.conviction ?? null,
      thesisTags:    md?.thesis_tags ?? [],
    },
    latestEntry:        entries[0] ? shapeEntry(entries[0]) : null,
    latestThesisHealth: latestThesis?.health?.thesis_health ?? (latestThesis ? 'none' : null),
    ...(withEntries && { entries: entries.map(shapeEntry) }),
  };
}

// ─── Default journals ─────────────────────────────────────────────────────────

/**
 * Idempotently ensure the two default journals ("Holdings", "Tracking") exist for
 * a user. Safe under concurrency thanks to the @@unique([user_id, default_kind]).
 * @returns {Promise<{ holdings: Journal, tracking: Journal }>}
 */
async function ensureDefaultJournals(userId) {
  const [holdings, tracking] = await Promise.all([
    prisma.journal.upsert({
      where:  { user_id_default_kind: { user_id: userId, default_kind: 'holdings' } },
      update: {},
      create: { user_id: userId, name: 'Holdings', kind: 'holdings', default_kind: 'holdings', is_default: true },
    }),
    prisma.journal.upsert({
      where:  { user_id_default_kind: { user_id: userId, default_kind: 'tracking' } },
      update: {},
      create: { user_id: userId, name: 'Tracking', kind: 'tracking', default_kind: 'tracking', is_default: true },
    }),
  ]);
  return { holdings, tracking };
}

// ─── Journals CRUD ────────────────────────────────────────────────────────────

/**
 * GET /api/journal/journals — the user's journals, fully expanded: every journal
 * carries its tickers (market-enriched), and every ticker carries all of its
 * entries (notes + theses). One call renders the whole journal UI.
 *
 * Defaults are ensured first, and the Holdings journal is synced (add-only) so its
 * tickers are as current as a detail read.
 */
async function listJournals(userId) {
  await ensureDefaultJournals(userId);

  // Lazy require avoids a require cycle (holdings-sync → journal.service).
  const { syncHoldingsJournal } = require('./holdings-sync.service');
  try {
    await syncHoldingsJournal(userId);
  } catch (err) {
    console.error('[listJournals] holdings sync failed:', err.message);
  }

  const journals = await prisma.journal.findMany({
    where:   { user_id: userId },
    include: {
      _count:  { select: { tickers: true } },
      tickers: {
        include: { entries: { orderBy: { created_at: 'desc' }, include: { health: true } } },
        orderBy: TICKER_ORDER,
      },
    },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });

  // One enrichment pass across every ticker in every journal — the same symbol in
  // two journals is priced once, not once per journal.
  const symbols    = [...new Set(journals.flatMap(j => j.tickers.map(t => t.ticker)))];
  const marketData = symbols.length ? await enrichHoldings(symbols) : {};

  return {
    journals: journals.map(j => ({
      ...shapeJournal(j, j._count.tickers),
      tickers: j.tickers.map(t => shapeJournalTicker(t, marketData[t.ticker], true)),
    })),
  };
}

/**
 * POST /api/journal/journals — create a custom journal.
 */
async function createJournal(userId, { name }) {
  const journal = await prisma.journal.create({
    data: { user_id: userId, name: name.trim(), kind: 'custom', is_default: false },
  });
  return shapeJournal(journal, 0);
}

/**
 * PATCH /api/journal/journals/:journalId — rename a custom journal.
 */
async function renameJournal(userId, journalId, { name }) {
  const journal = await assertJournalOwnership(userId, journalId);
  if (journal.is_default) {
    throw badRequest('Default journals cannot be renamed', 'DEFAULT_JOURNAL');
  }
  const updated = await prisma.journal.update({
    where:   { id: journalId },
    data:    { name: name.trim() },
    include: { _count: { select: { tickers: true } } },
  });
  return shapeJournal(updated, updated._count.tickers);
}

/**
 * DELETE /api/journal/journals/:journalId — delete a custom journal (cascade).
 */
async function deleteJournal(userId, journalId) {
  const journal = await assertJournalOwnership(userId, journalId);
  if (journal.is_default) {
    throw badRequest('Default journals cannot be deleted', 'DEFAULT_JOURNAL');
  }
  await prisma.journal.delete({ where: { id: journalId } });
}

/**
 * GET /api/journal/journals/:journalId — journal detail with tickers, market
 * enrichment, latest entry + latest thesis-health per ticker. For the Holdings
 * default journal, runs an add-only holdings sync first so it stays current even
 * without a manual trigger.
 */
async function getJournalDetail(userId, journalId) {
  const journal = await assertJournalOwnership(userId, journalId);

  if (journal.kind === 'holdings') {
    // Lazy require avoids a require cycle (holdings-sync → journal.service).
    const { syncHoldingsJournal } = require('./holdings-sync.service');
    try {
      await syncHoldingsJournal(userId);
    } catch (err) {
      console.error('[getJournalDetail] holdings sync failed:', err.message);
    }
  }

  const tickers = await prisma.journalTicker.findMany({
    where:   { journal_id: journalId },
    include: {
      entries: { orderBy: { created_at: 'desc' }, include: { health: true } },
    },
    orderBy: TICKER_ORDER,
  });

  const symbols    = [...new Set(tickers.map(t => t.ticker))];
  const marketData = symbols.length ? await enrichHoldings(symbols) : {};

  return {
    journal: shapeJournal(journal, tickers.length),
    tickers: tickers.map(t => shapeJournalTicker(t, marketData[t.ticker])),
  };
}

// ─── Tickers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/journal/journals/:journalId/tickers — add one or more tickers
 * (manual source). Idempotent: existing tickers are left untouched.
 */
async function addTickers(userId, journalId, tickers) {
  await assertJournalOwnership(userId, journalId);

  const unique = [...new Set(tickers.map(normTicker))].filter(Boolean);
  if (!unique.length) throw badRequest('No valid tickers provided', 'NO_TICKERS');

  let added = 0;
  for (const ticker of unique) {
    const existing = await prisma.journalTicker.findUnique({
      where: { journal_id_ticker: { journal_id: journalId, ticker } },
    });
    if (!existing) {
      await prisma.journalTicker.create({
        data: { journal_id: journalId, ticker, source: 'manual' },
      });
      added++;
    }
  }

  return { added, tickers: unique };
}

/**
 * DELETE /api/journal/journals/:journalId/tickers/:ticker — remove a ticker from
 * a journal (cascade-deletes its entries). Note: a still-held ticker removed from
 * the Holdings journal will reappear on the next holdings sync (add-only mirror).
 */
async function removeTicker(userId, journalId, tickerParam) {
  await assertJournalOwnership(userId, journalId);
  const ticker = normTicker(tickerParam);

  const deleted = await prisma.journalTicker.deleteMany({
    where: { journal_id: journalId, ticker },
  });
  if (deleted.count === 0) {
    throw notFound(`${ticker} is not in this journal`, 'TICKER_NOT_FOUND');
  }
}

// ─── Entries ──────────────────────────────────────────────────────────────────

/**
 * GET /api/journal/journals/:journalId/tickers/:ticker/entries — timestamped
 * entries (notes + theses) for a ticker within a journal, newest first.
 */
async function listEntries(userId, journalId, tickerParam) {
  await assertJournalOwnership(userId, journalId);
  const ticker = normTicker(tickerParam);

  const journalTicker = await prisma.journalTicker.findUnique({
    where:   { journal_id_ticker: { journal_id: journalId, ticker } },
    include: { entries: { orderBy: { created_at: 'desc' }, include: { health: true } } },
  });
  if (!journalTicker) throw notFound(`${ticker} is not in this journal`, 'TICKER_NOT_FOUND');

  return {
    ticker,
    entries: journalTicker.entries.map(shapeEntry),
  };
}

/**
 * POST /api/journal/journals/:journalId/tickers/:ticker/entries — add a note or a
 * full thesis. Auto-creates the JournalTicker (source 'manual') if the ticker
 * isn't in the journal yet, so "add a note to a ticker" is a single call. When the
 * entry is a thesis (dimension present) it snapshots lens scores and runs health.
 */
async function createEntry(userId, journalId, tickerParam, body) {
  await assertJournalOwnership(userId, journalId);
  const ticker = normTicker(tickerParam);
  if (!ticker) throw badRequest('ticker is required', 'NO_TICKER');

  // Ensure the ticker exists in this journal (idempotent).
  const journalTicker = await prisma.journalTicker.upsert({
    where:  { journal_id_ticker: { journal_id: journalId, ticker } },
    update: {},
    create: { journal_id: journalId, ticker, source: 'manual' },
  });

  const isThesis = body.dimension != null;

  let scoresSnapshot = null;
  if (isThesis) {
    const lensMap = await fetchLensScoreMap(ticker);
    scoresSnapshot = buildSnapshot(body.subFactors, lensMap);
  }

  const entry = await prisma.journalEntry.create({
    data: {
      journal_ticker_id: journalTicker.id,
      note_text:         body.noteText ?? null,
      dimension:         body.dimension ?? null,
      sub_factors:       isThesis ? body.subFactors : null,
      thesis:            body.thesis ?? null,
      conviction:        body.conviction ?? null,
      scores_snapshot:   scoresSnapshot,
    },
  });

  let health = null;
  if (isThesis) {
    health = await evaluateHealth(entry.id);
  }

  const full = await prisma.journalEntry.findUnique({
    where:   { id: entry.id },
    include: { health: true },
  });

  return {
    ...shapeEntry(full),
    ticker,
    journalId,
    thesisHealth: health?.thesisHealth ?? shapeEntry(full).thesisHealth,
    aiNudge:      health?.aiNudge ?? full.health?.ai_nudge ?? null,
  };
}

/**
 * PATCH /api/journal/entries/:entryId — edit an entry. Thesis fields re-snapshot
 * lens scores and re-run health.
 */
async function updateEntry(userId, entryId, fields) {
  const existing = await assertEntryOwnership(userId, entryId);

  const data = {};
  if (fields.noteText   !== undefined) data.note_text  = fields.noteText;
  if (fields.dimension  !== undefined) data.dimension  = fields.dimension;
  if (fields.thesis     !== undefined) data.thesis     = fields.thesis;
  if (fields.conviction !== undefined) data.conviction = fields.conviction;

  // If sub-factors change (or a thesis is being (re)defined), re-snapshot.
  const willBeThesis = (fields.dimension ?? existing.dimension) != null;
  if (fields.subFactors !== undefined) {
    data.sub_factors = fields.subFactors;
    if (willBeThesis) {
      const lensMap = await fetchLensScoreMap(existing.journal_ticker.ticker);
      data.scores_snapshot = buildSnapshot(fields.subFactors, lensMap);
    }
  }

  await prisma.journalEntry.update({ where: { id: entryId }, data });

  let health = null;
  if (willBeThesis) {
    health = await evaluateHealth(entryId);
  }

  const full = await prisma.journalEntry.findUnique({
    where:   { id: entryId },
    include: { health: true },
  });

  return {
    ...shapeEntry(full),
    ticker:       existing.journal_ticker.ticker,
    thesisHealth: health?.thesisHealth ?? shapeEntry(full).thesisHealth,
    aiNudge:      health?.aiNudge ?? full.health?.ai_nudge ?? null,
  };
}

/**
 * DELETE /api/journal/entries/:entryId — delete an entry (cascade-deletes health).
 */
async function deleteEntry(userId, entryId) {
  await assertEntryOwnership(userId, entryId);
  await prisma.journalEntry.delete({ where: { id: entryId } });
}

/**
 * POST /api/journal/entries/:entryId/evaluate — manually re-run thesis health.
 */
async function triggerEvaluate(userId, entryId) {
  const existing = await assertEntryOwnership(userId, entryId);
  if (!existing.dimension) {
    throw badRequest('Only thesis entries can be evaluated', 'NOT_A_THESIS');
  }
  const { thesisHealth, aiNudge, evaluatedAt } = await evaluateHealth(entryId);
  return { entryId, thesisHealth, aiNudge, evaluatedAt };
}

module.exports = {
  ensureDefaultJournals,
  listJournals,
  createJournal,
  renameJournal,
  deleteJournal,
  getJournalDetail,
  addTickers,
  removeTicker,
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  triggerEvaluate,
  VALID_SUB_FACTORS,
  resolveSubFactorSlug,
  // exported for tests / reuse
  notFound,
  badRequest,
  normTicker,
};
