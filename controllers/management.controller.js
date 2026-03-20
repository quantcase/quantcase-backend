'use strict';

const asyncHandler        = require('../middleware/asyncHandler');
const managementService   = require('../services/management.service');

const getManagementAnalysis = asyncHandler(async (req, res) => {
  const { callId, timeframe = 'rolling_3_year' } = req.query;
  const data = await managementService.computeManagementAnalysis(callId, timeframe);
  res.json({ success: true, data });
});

module.exports = { getManagementAnalysis };
