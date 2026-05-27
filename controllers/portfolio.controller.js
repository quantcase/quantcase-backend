'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const userPortSvc  = require('../services/portfolio/user-portfolio.service');
const shadowSvc    = require('../services/portfolio/shadow-portfolio.service');
const notesSvc     = require('../services/portfolio/holding-notes.service');

// ─── User Portfolio ───────────────────────────────────────────────────────────

const uploadUserPortfolio = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Send CSV or XLSX in the `file` field.' });
  }
  const holdings = userPortSvc.parsePortfolioBuffer(req.file.buffer);
  const result   = await userPortSvc.replaceUserPortfolio(req.user.sub, holdings);
  res.status(201).json({ success: true, data: result });
});

const getUserPortfolio = asyncHandler(async (req, res) => {
  const portfolio = await userPortSvc.getUserPortfolio(req.user.sub);
  res.json({ success: true, data: portfolio });
});

// ─── Shadow Portfolio ─────────────────────────────────────────────────────────

const getShadowPortfolio = asyncHandler(async (req, res) => {
  const portfolio = await shadowSvc.getShadowPortfolio(req.user.sub);
  res.json({ success: true, data: portfolio });
});

const addToShadowPortfolio = asyncHandler(async (req, res) => {
  const { ticker, amount_invested, invested_at } = req.body;
  const holding = await shadowSvc.addHoldingToShadow(req.user.sub, { ticker, amount_invested, invested_at });
  res.status(201).json({ success: true, data: holding });
});

// ─── Holdings CRUD ────────────────────────────────────────────────────────────

const updateHolding = asyncHandler(async (req, res) => {
  const updated = await shadowSvc.updateHolding(req.params.holdingId, req.user.sub, req.body);
  res.json({ success: true, data: updated });
});

const deleteHolding = asyncHandler(async (req, res) => {
  await shadowSvc.deleteHolding(req.params.holdingId, req.user.sub);
  res.json({ success: true, deleted_id: req.params.holdingId });
});

// ─── Holding Notes ────────────────────────────────────────────────────────────

const createNote = asyncHandler(async (req, res) => {
  const note = await notesSvc.createNote(req.params.holdingId, req.user.sub, req.body.note_text);
  res.status(201).json({ success: true, data: note });
});

const updateNote = asyncHandler(async (req, res) => {
  const note = await notesSvc.updateNote(req.params.noteId, req.user.sub, req.body.note_text);
  res.json({ success: true, data: note });
});

const deleteNote = asyncHandler(async (req, res) => {
  await notesSvc.deleteNote(req.params.noteId, req.user.sub);
  res.json({ success: true, deleted_id: req.params.noteId });
});

module.exports = {
  uploadUserPortfolio,
  getUserPortfolio,
  getShadowPortfolio,
  addToShadowPortfolio,
  updateHolding,
  deleteHolding,
  createNote,
  updateNote,
  deleteNote,
};
