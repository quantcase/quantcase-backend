'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/actions.service');

const logAction = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const rmProfileId = req.wealthRmProfile?.id || req.body.rm_id || req.body.rm_profile_id || null;
  const action = await service.logAction(orgId, req.body, rmProfileId);
  res.status(201).json({ success: true, data: action });
});

module.exports = { logAction };
