'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/models.service');

const listModels = asyncHandler(async (req, res) => {
  const data = await service.listModels();
  res.json({ success: true, data });
});

const createModel = asyncHandler(async (req, res) => {
  const data = await service.createModel(req.body);
  res.status(201).json({ success: true, data });
});

module.exports = { listModels, createModel };
