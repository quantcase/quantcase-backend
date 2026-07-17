'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const service       = require('../services/admin.kpiGroups.service');

function handleServiceError(err, res, next) {
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
  next(err);
}

const listKpiGroups = asyncHandler(async (req, res) => {
  const data = await service.listKpiGroups(req.query);
  res.json({ success: true, data });
});

const getKpiGroupTree = asyncHandler(async (req, res) => {
  const data = await service.getKpiGroupTree();
  res.json({ success: true, data });
});

const getKpiGroup = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.getKpiGroup(req.params.slug);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const createKpiGroup = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.createKpiGroup(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const updateKpiGroup = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.updateKpiGroup(req.params.slug, req.body);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const deleteKpiGroup = asyncHandler(async (req, res, next) => {
  try {
    await service.deleteKpiGroup(req.params.slug);
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

module.exports = { listKpiGroups, getKpiGroupTree, getKpiGroup, createKpiGroup, updateKpiGroup, deleteKpiGroup };
