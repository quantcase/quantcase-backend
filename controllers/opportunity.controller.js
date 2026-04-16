'use strict';

const asyncHandler          = require('../middleware/asyncHandler');
const opportunityService    = require('../services/opportunity.service');
const industryService       = require('../services/industry.service');

const getOFactorAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const result = await opportunityService.getOFactorForCall(callId);
  if (!result) return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
  res.json({ success: true, data: result.result, total_score: result.total_score });
});

const getOFactorAnalysisByQuery = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const result = await opportunityService.getOFactorByQuery(callId);
  if (!result) return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
  res.json({ success: true, data: result.result, total_score: result.total_score });
});

const getPeerData = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const data = await opportunityService.getPeerDataForCall(callId);
  res.json({ success: true, ...data });
});

const getOFactorPrompt = asyncHandler(async (req, res) => {
  const { section, callId } = req.query;
  const bfsi = await opportunityService.resolveBfsi(callId);
  try {
    const data = opportunityService.getOFactorPromptData(section, bfsi);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    throw err;
  }
});

const getIndustryAnalysis = asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker query param is required' });
  const record = await industryService.fetchIndustryResult(ticker);
  if (!record) return res.status(404).json({ success: false, error: 'Industry analysis not yet available — trigger via POST first' });
  res.json({ success: true, data: record.data, analyzedAt: record.analyzedAt });
});

module.exports = { getOFactorAnalysis, getOFactorAnalysisByQuery, getPeerData, getOFactorPrompt, getIndustryAnalysis };
