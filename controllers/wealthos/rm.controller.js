'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/rm.service');

const listRm = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.listRmProfiles(orgId);
  res.json({ success: true, data });
});

const getRmById = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const rmId = req.params.rmId || req.params.rmProfileId;
  const data = await service.getRmProfileById(orgId, rmId);
  res.json({ success: true, data });
});

const createRm = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.createRmProfile(orgId, req.body);
  res.status(201).json({ success: true, data });
});

module.exports = { listRm, getRmById, createRm };
