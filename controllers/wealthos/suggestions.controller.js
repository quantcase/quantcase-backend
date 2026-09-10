'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/suggestions.service');

const generateSuggestions = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { client_ids } = req.body;
  const rmProfileId = req.wealthRmProfile?.id || req.body.rm_profile_id || req.body.rm_id || null;

  const jobs = await service.enqueueSuggestionGeneration(orgId, client_ids, rmProfileId);
  res.json({
    success: true,
    message: `${jobs.length} suggestion job(s) queued`,
    jobs,
  });
});

const updateSuggestionStatus = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { suggestionId } = req.params;
  const { status } = req.body;
  const rmProfileId = req.wealthRmProfile?.id || req.body.rm_profile_id || req.body.rm_id || null;

  const updated = await service.updateSuggestionStatus(orgId, suggestionId, status, rmProfileId);
  res.json({ success: true, data: updated });
});

module.exports = { generateSuggestions, updateSuggestionStatus };
