'use strict';

const asyncHandler          = require('../middleware/asyncHandler');
const opportunityService    = require('../services/opportunity.service');
const jobsService           = require('../services/jobs.service');
const industryService       = require('../services/industry.service');
const prisma                = require('../config/prisma');
const jobQueue              = require('../lib/jobQueue');

const VALID_SECTIONS = opportunityService.VALID_SECTIONS;

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
  if (!VALID_SECTIONS.has(section)) {
    return res.status(400).json({ success: false, error: `Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}` });
  }
  const bfsi = await opportunityService.resolveBfsi(callId);
  const data = opportunityService.getOFactorPromptData(section, bfsi);
  res.json({ success: true, data });
});

const enqueueCustomOFactorAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const { section, customInstructions } = req.body ?? {};

  if (!section) return res.status(400).json({ success: false, error: 'section is required in request body' });
  if (!VALID_SECTIONS.has(section)) {
    return res.status(400).json({ success: false, error: `Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}` });
  }
  if (!customInstructions || typeof customInstructions !== 'string' || !customInstructions.trim()) {
    return res.status(400).json({ success: false, error: 'customInstructions must be a non-empty string' });
  }

  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) return res.status(404).json({ success: false, error: 'Call not found' });

  const job = await jobQueue.addJob('ofactor_analysis', {
    callId,
    type:               'ofactor_analysis',
    subjectTicker:      call.company,
    section,
    customInstructions: customInstructions.trim(),
    customRun:          true,
  }, { jobId: `ofactor_custom_${callId}_${section}_${Date.now()}` });

  res.json({
    success: true,
    message: `Custom OFactor "${section}" analysis job queued`,
    job: { id: job.id, callId, type: 'ofactor_analysis', section, status: 'pending', createdAt: new Date(job.timestamp).toISOString() },
  });
});

const createIndustryAnalysis = asyncHandler(async (req, res) => {
  const { ticker } = req.params;
  const job = await industryService.createIndustryJob(ticker);
  res.json({
    success: true,
    message: 'NSE industry analysis job created and queued',
    job: { id: job.id, ticker, type: 'nse_industry', status: 'pending' },
  });
});

const getIndustryAnalysis = asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker query param is required' });
  const record = await industryService.fetchIndustryResult(ticker);
  if (!record) return res.status(404).json({ success: false, error: 'Industry analysis not yet available — trigger via POST first' });
  res.json({ success: true, data: record.data, analyzedAt: record.analyzedAt });
});

module.exports = { getOFactorAnalysis, getOFactorAnalysisByQuery, getPeerData, getOFactorPrompt, enqueueCustomOFactorAnalysis, createIndustryAnalysis, getIndustryAnalysis };
