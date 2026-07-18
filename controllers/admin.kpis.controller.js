'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const kpisService  = require('../services/admin.kpis.service');

function handleServiceError(err, res, next) {
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
  next(err);
}

const listKpis = asyncHandler(async (req, res) => {
  const data = await kpisService.listKpis(req.query);
  res.json({ success: true, data });
});

const getKpi = asyncHandler(async (req, res, next) => {
  try {
    const data = await kpisService.getKpi(req.params.abbr);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const createKpi = asyncHandler(async (req, res, next) => {
  try {
    const data = await kpisService.createKpi(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const updateKpi = asyncHandler(async (req, res, next) => {
  try {
    const data = await kpisService.updateKpi(req.params.abbr, req.body);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const listRelationships = asyncHandler(async (req, res) => {
  const data = await kpisService.listRelationships(req.params.abbr, req.query.type);
  res.json({ success: true, data });
});

const createRelationship = asyncHandler(async (req, res, next) => {
  try {
    const data = await kpisService.createRelationship(req.params.abbr, req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const deleteRelationship = asyncHandler(async (req, res, next) => {
  try {
    await kpisService.deleteRelationship(req.params.abbr, req.params.id);
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

const previewKpi = asyncHandler(async (req, res, next) => {
  try {
    const data = await kpisService.previewKpi(req.params.abbr, req.query);
    res.json({ success: true, data });
  } catch (err) { handleServiceError(err, res, next); }
});

const validateFormula = asyncHandler(async (req, res) => {
  const data = await kpisService.validateFormula(req.body.formula_expression);
  res.json({ success: true, data });
});

module.exports = {
  listKpis, getKpi, createKpi, updateKpi,
  listRelationships, createRelationship, deleteRelationship,
  previewKpi, validateFormula,
};
