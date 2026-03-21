'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/analytics.service');

const getRmMetrics = asyncHandler(async (req, res) => {
  const data = await service.getRmPerformanceMetrics(req.params.rmId);
  res.json({ success: true, data });
});

const getClientSegmentation = asyncHandler(async (req, res) => {
  const data = await service.getClientSegmentationAnalytics();
  res.json({ success: true, data });
});

module.exports = { getRmMetrics, getClientSegmentation };
