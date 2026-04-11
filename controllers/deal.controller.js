'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const dealService   = require('../services/deal.service');

const createDealAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Deal] POST /deal/analysis  callId=${callId}`);
  const job = await dealService.createDealJob(callId);
  res.json({
    success: true,
    message: 'Deal analysis job created and queued',
    job: { id: job.jobId, callId, type: 'deal_analysis', status: 'pending' },
  });
});

const getDealAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const record = await dealService.fetchDealResult(callId);
  if (!record) return res.status(404).json({ success: false, error: 'Deal analysis not yet available — trigger via POST first' });
  const { data, inputs } = dealService.formatDealResult(record);
  res.json({ success: true, data, inputs });
});

const getDealAnalysisByQuery = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const record = await dealService.fetchDealResult(callId);
  if (!record) return res.status(404).json({ success: false, error: 'No deal analysis available yet — trigger via POST first' });
  const { data, inputs } = dealService.formatDealResult(record);
  res.json({ success: true, data, inputs });
});

module.exports = { createDealAnalysis, getDealAnalysis, getDealAnalysisByQuery };
