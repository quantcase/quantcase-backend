'use strict';

const asyncHandler      = require('../middleware/asyncHandler');
const analysisService   = require('../services/analysis.service');

const VALID_TYPES = new Set(['management', 'opportunity', 'deal']);

/**
 * GET /api/analysis?callId=X&type=management,opportunity
 * Returns AiInsight objects + constituent Lens data for each requested type.
 */
const getAnalysis = asyncHandler(async (req, res) => {
  const { callId, type } = req.query;
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

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

  const result = await analysisService.getAnalysis(callId, types);
  res.json({ success: true, ...result });
});

/**
 * POST /api/analysis
 * Body: { callId, types: ['management','opportunity'], forceRefresh?: boolean }
 * Enqueues aiInsightSynthesis jobs and returns jobIds for polling.
 */
const enqueueAnalysis = asyncHandler(async (req, res) => {
  const { callId, types, forceRefresh } = req.body;
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const requestedTypes = Array.isArray(types) ? types : ['management', 'opportunity'];
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

module.exports = { getAnalysis, enqueueAnalysis };
