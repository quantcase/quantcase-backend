'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/suggestions.service');

const generateSuggestions = asyncHandler(async (req, res) => {
  const { client_ids, rm_id } = req.body;
  const jobs = await service.enqueueSuggestionGeneration(client_ids, rm_id);
  res.json({
    success: true,
    message: `${jobs.length} suggestion job(s) queued`,
    jobs,
  });
});

const updateSuggestionStatus = asyncHandler(async (req, res) => {
  const { suggestionId } = req.params;
  const { status, rm_id } = req.body;
  const updated = await service.updateSuggestionStatus(suggestionId, status, rm_id);
  res.json({ success: true, data: updated });
});

module.exports = { generateSuggestions, updateSuggestionStatus };
