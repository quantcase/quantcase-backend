'use strict';

const asyncHandler     = require('../middleware/asyncHandler');
const summaryService   = require('../services/summary.service');

const getSummary = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const summary = await summaryService.getSummaryByCallId(callId);
  if (!summary) return res.status(404).json({ success: false, error: 'Summary not found for this call' });
  res.json({ success: true, data: summary });
});

module.exports = { getSummary };
