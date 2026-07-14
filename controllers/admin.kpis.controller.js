'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const kpisService  = require('../services/admin.kpis.service');

const listKpis = asyncHandler(async (req, res) => {
  const data = await kpisService.listKpis(req.query);
  res.json({ success: true, data });
});

const createKpi = asyncHandler(async (req, res) => {
  try {
    const data = await kpisService.createKpi(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    throw err;
  }
});

module.exports = { listKpis, createKpi };
