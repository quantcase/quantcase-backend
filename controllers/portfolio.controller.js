'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const userPortSvc  = require('../services/portfolio/user-portfolio.service');
const shadowSvc    = require('../services/portfolio/shadow-portfolio.service');
const modSynopsisSvc     = require('../services/dashboard/mod-synopsis.service');
const holdingsSummarySvc = require('../services/dashboard/holdings-summary.service');
const whatsMovingSvc     = require('../services/dashboard/whats-moving.service');

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

// ─── Investor Dashboard ───────────────────────────────────────────────────────

const getModSynopsis = asyncHandler(async (req, res) => {
  const data = await modSynopsisSvc.getModSynopsis(req.user.sub);
  res.json({ success: true, data });
});

const getHoldingsSummary = asyncHandler(async (req, res) => {
  const data = await holdingsSummarySvc.getHoldingsSummary(req.user.sub);
  res.json({ success: true, data });
});

const getWhatsMoving = asyncHandler(async (req, res) => {
  const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10)) : 10;
  const data  = await whatsMovingSvc.getWhatsMoving(req.user.sub, { limit });
  res.json({ success: true, data });
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

module.exports = {
  uploadUserPortfolio,
  getUserPortfolio,
  getModSynopsis,
  getHoldingsSummary,
  getWhatsMoving,
  getShadowPortfolio,
  addToShadowPortfolio,
  updateHolding,
  deleteHolding,
};
