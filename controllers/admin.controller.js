'use strict';

const asyncHandler   = require('../middleware/asyncHandler');
const adminService   = require('../services/admin.service');

const getOpportunityStats = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const result = await adminService.computeOpportunityStats(callId);
  res.json({ success: true, ...result });
});

module.exports = { getOpportunityStats };
