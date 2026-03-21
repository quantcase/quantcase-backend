'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/rm.service');

const listRm = asyncHandler(async (req, res) => {
  const data = await service.listRmUsers();
  res.json({ success: true, data });
});

const getRmById = asyncHandler(async (req, res) => {
  const data = await service.getRmById(req.params.rmId);
  res.json({ success: true, data });
});

const createRm = asyncHandler(async (req, res) => {
  const data = await service.createRmUser(req.body);
  res.status(201).json({ success: true, data });
});

module.exports = { listRm, getRmById, createRm };
