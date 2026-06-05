'use strict';

const asyncHandler      = require('../middleware/asyncHandler');
const analysisService   = require('../services/analysis.service');
const { enqueueOverviewSynthesisJob, getOverviewInsight } = require('../services/overviewSynthesis.service');
const prisma            = require('../config/prisma');

const VALID_TYPES = new Set(['management', 'opportunity', 'deal']);

/**
 * GET /api/analysis?callId=X&type=management,opportunity
 * Returns AiInsight objects + constituent Lens data for each requested type.
 */
const getAnalysis = asyncHandler(async (req, res) => {
  const { ticker, type } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const types = (type ?? 'management,opportunity,deal')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => VALID_TYPES.has(t));

  if (types.length === 0) {
    return res.status(400).json({
      success: false,
      error: `Invalid type(s). Valid values: ${[...VALID_TYPES].join(', ')}`,
    });
  }

  const result = await analysisService.getAnalysis(ticker, types);
  res.json({ success: true, data: result });
});

/**
 * POST /api/analysis
 * Body: { callId, types: ['management','opportunity'], forceRefresh?: boolean }
 * Enqueues aiInsightSynthesis jobs and returns jobIds for polling.
 */
const enqueueAnalysis = asyncHandler(async (req, res) => {
  const { callId, types, forceRefresh } = req.body;
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const requestedTypes = Array.isArray(types) ? types : ['management', 'opportunity', 'deal'];
  const validTypes = requestedTypes
    .map(t => String(t).trim().toLowerCase())
    .filter(t => VALID_TYPES.has(t));

  if (validTypes.length === 0) {
    return res.status(400).json({
      success: false,
      error: `Invalid types. Valid values: ${[...VALID_TYPES].join(', ')}`,
    });
  }

  const jobs = await analysisService.enqueueAnalysis(callId, validTypes, { forceRefresh: !!forceRefresh });
  res.json({
    success: true,
    message: `Enqueued ${jobs.length} analysis job(s)`,
    callId,
    jobs,
  });
});

/**
 * GET /api/analysis/overview?ticker=X
 * Returns the stored overview AiInsight for the given ticker.
 */
const getOverview = asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const record = await getOverviewInsight(ticker);

  res.json({
    success: true,
    data: {
      ticker,
      available: !!record,
      ...(record?.insight ?? {}),
      analyzed_at: record?.updated_at ?? null,
    },
  });
});

/**
 * POST /api/analysis/overview
 * Body: { ticker, forceRefresh?: boolean }
 * Enqueues an overview synthesis job and returns the jobId for polling.
 */
const enqueueOverview = asyncHandler(async (req, res) => {
  const { ticker, forceRefresh } = req.body;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const { jobId } = await enqueueOverviewSynthesisJob(ticker, { forceRefresh: !!forceRefresh });

  res.json({
    success: true,
    message: 'Overview synthesis job enqueued',
    ticker,
    jobId,
  });
});

module.exports = { getAnalysis, enqueueAnalysis, getOverview, enqueueOverview };
