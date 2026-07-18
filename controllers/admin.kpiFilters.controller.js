'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const service       = require('../services/admin.kpiFilters.service');

function handleServiceError(err, res, next) {
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
  next(err);
}

const listKpiFilters = asyncHandler(async (req, res) => {
  const data = await service.listKpiFilters(req.query);
  res.json({ success: true, data });
});

const getKpiFilter = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.getKpiFilter(req.params.slug);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const createKpiFilter = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.createKpiFilter(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const updateKpiFilter = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.updateKpiFilter(req.params.slug, req.body);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const deleteKpiFilter = asyncHandler(async (req, res, next) => {
  try {
    await service.deleteKpiFilter(req.params.slug);
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

module.exports = { listKpiFilters, getKpiFilter, createKpiFilter, updateKpiFilter, deleteKpiFilter };
