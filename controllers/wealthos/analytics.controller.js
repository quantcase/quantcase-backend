'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/analytics.service');

const getRmMetrics = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const targetRmId = req.params.rmId || req.params.rmProfileId;

  // If caller is an RM, they can only view their own metrics
  if (req.wealthRole === 'rm' && targetRmId !== req.wealthRmProfile?.id) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: RMs can only access their own performance analytics',
    });
  }

  const data = await service.getRmPerformanceMetrics(orgId, targetRmId);
  res.json({ success: true, data });
});

const getClientSegmentation = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.getClientSegmentationAnalytics(orgId);
  res.json({ success: true, data });
});

const getFirmSummary = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.getFirmSummaryAnalytics(orgId);
  res.json({ success: true, data });
});

module.exports = { getRmMetrics, getClientSegmentation, getFirmSummary };
