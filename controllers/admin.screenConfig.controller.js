'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const service       = require('../services/admin.screenConfig.service');

function handleServiceError(err, res, next) {
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
  next(err);
}

const listScreenConfigs = asyncHandler(async (req, res) => {
  const data = await service.listScreenConfigs(req.query);
  res.json({ success: true, data });
});

const getScreenConfig = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.getScreenConfig(req.params.key);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const createScreenConfig = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.createScreenConfig(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const updateScreenConfig = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.updateScreenConfig(req.params.key, req.body);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const deleteScreenConfig = asyncHandler(async (req, res, next) => {
  try {
    await service.deleteScreenConfig(req.params.key);
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

const addItem = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.addItem(req.params.key, req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const updateItem = asyncHandler(async (req, res, next) => {
  try {
    const data = await service.updateItem(req.params.key, req.params.itemId, req.body);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const removeItem = asyncHandler(async (req, res, next) => {
  try {
    await service.removeItem(req.params.key, req.params.itemId);
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

module.exports = {
  listScreenConfigs, getScreenConfig, createScreenConfig, updateScreenConfig, deleteScreenConfig,
  addItem, updateItem, removeItem,
};
