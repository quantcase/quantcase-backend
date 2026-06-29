'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const svc          = require('../services/journal/journal.service');

const getPending = asyncHandler(async (req, res) => {
  const data = await svc.getPendingHoldings(req.user.sub);
  res.json({ success: true, data });
});

const getAllEntries = asyncHandler(async (req, res) => {
  const data = await svc.getAllEntries(req.user.sub);
  res.json({ success: true, data });
});

const createEntry = asyncHandler(async (req, res) => {
  const { symbol, portfolioType, dimension, subFactors, thesis, conviction } = req.body;
  const data = await svc.createEntry(req.user.sub, { symbol, portfolioType, dimension, subFactors, thesis, conviction });
  res.status(201).json({ success: true, data });
});

const getEntry = asyncHandler(async (req, res) => {
  const portfolioType = req.query.portfolioType ?? 'user';
  const data = await svc.getEntry(req.params.symbol, req.user.sub, portfolioType);
  res.json({ success: true, data });
});

const updateEntry = asyncHandler(async (req, res) => {
  const data = await svc.updateEntry(req.params.entryId, req.user.sub, req.body);
  res.json({ success: true, data });
});

const deleteEntry = asyncHandler(async (req, res) => {
  await svc.deleteEntry(req.params.entryId, req.user.sub);
  res.json({ success: true, data: { deleted: true } });
});

const evaluateEntry = asyncHandler(async (req, res) => {
  const result = await svc.triggerEvaluate(req.params.entryId, req.user.sub);
  res.json({
    success: true,
    data: {
      entryId:      req.params.entryId,
      thesisHealth: result.thesisHealth,
      aiNudge:      result.aiNudge,
      evaluatedAt:  result.evaluatedAt,
    },
  });
});

module.exports = { getPending, getAllEntries, createEntry, getEntry, updateEntry, deleteEntry, evaluateEntry };
