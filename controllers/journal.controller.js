'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const svc          = require('../services/journal/journal.service');
const { syncHoldingsJournal } = require('../services/journal/holdings-sync.service');

// ─── Journals ─────────────────────────────────────────────────────────────────

const listJournals = asyncHandler(async (req, res) => {
  const data = await svc.listJournals(req.user.sub);
  res.json({ success: true, data });
});

const createJournal = asyncHandler(async (req, res) => {
  const data = await svc.createJournal(req.user.sub, { name: req.body.name });
  res.status(201).json({ success: true, data });
});

const renameJournal = asyncHandler(async (req, res) => {
  const data = await svc.renameJournal(req.user.sub, req.params.journalId, { name: req.body.name });
  res.json({ success: true, data });
});

const deleteJournal = asyncHandler(async (req, res) => {
  await svc.deleteJournal(req.user.sub, req.params.journalId);
  res.json({ success: true, data: { deleted: true } });
});

const getJournalDetail = asyncHandler(async (req, res) => {
  const data = await svc.getJournalDetail(req.user.sub, req.params.journalId);
  res.json({ success: true, data });
});

// ─── Tickers ──────────────────────────────────────────────────────────────────

const addTickers = asyncHandler(async (req, res) => {
  const data = await svc.addTickers(req.user.sub, req.params.journalId, req.body.tickers);
  res.status(201).json({ success: true, data });
});

const removeTicker = asyncHandler(async (req, res) => {
  await svc.removeTicker(req.user.sub, req.params.journalId, req.params.ticker);
  res.json({ success: true, data: { deleted: true } });
});

// ─── Entries ──────────────────────────────────────────────────────────────────

const listEntries = asyncHandler(async (req, res) => {
  const data = await svc.listEntries(req.user.sub, req.params.journalId, req.params.ticker);
  res.json({ success: true, data });
});

const createEntry = asyncHandler(async (req, res) => {
  const data = await svc.createEntry(req.user.sub, req.params.journalId, req.params.ticker, req.body);
  res.status(201).json({ success: true, data });
});

const updateEntry = asyncHandler(async (req, res) => {
  const data = await svc.updateEntry(req.user.sub, req.params.entryId, req.body);
  res.json({ success: true, data });
});

const deleteEntry = asyncHandler(async (req, res) => {
  await svc.deleteEntry(req.user.sub, req.params.entryId);
  res.json({ success: true, data: { deleted: true } });
});

const evaluateEntry = asyncHandler(async (req, res) => {
  const data = await svc.triggerEvaluate(req.user.sub, req.params.entryId);
  res.json({ success: true, data });
});

// ─── Holdings sync ────────────────────────────────────────────────────────────

const syncHoldings = asyncHandler(async (req, res) => {
  const data = await syncHoldingsJournal(req.user.sub);
  res.json({ success: true, data });
});

module.exports = {
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
  evaluateEntry,
  syncHoldings,
};
