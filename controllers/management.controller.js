'use strict';

const asyncHandler        = require('../middleware/asyncHandler');
const managementService   = require('../services/management.service');

const createManagementAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await managementService.createManagementJob(callId);
  res.json({
    success: true,
    message: 'Management analysis job created and queued',
    job: { id: job.id, callId, type: 'management_analysis', status: 'pending' },
  });
});

const getManagementAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const record = await managementService.fetchManagementResult(callId);
  if (!record) return res.status(404).json({ success: false, error: 'Management analysis not yet available — trigger via POST first' });
  res.json({ success: true, data: record.insight });
});

module.exports = { createManagementAnalysis, getManagementAnalysis };
