'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/models.service');

const listModels = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.listModels(orgId, req.query);
  res.json({ success: true, data });
});

const getModelById = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.getModelById(orgId, req.params.modelId);
  res.json({ success: true, data });
});

const createModel = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.createModel(orgId, req.body, req.wealthMember.id);
  res.status(201).json({ success: true, data });
});

const publishModel = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.publishModel(orgId, req.params.modelId, req.wealthMember.id);
  res.json({ success: true, data });
});

module.exports = { listModels, getModelById, createModel, publishModel };
