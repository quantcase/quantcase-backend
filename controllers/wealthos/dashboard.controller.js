'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/dashboard.service');

const getDashboardToday = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;

  let rmProfileId = null;
  if (req.wealthRole === 'rm') {
    rmProfileId = req.wealthRmProfile?.id;
  } else {
    rmProfileId = req.query.rm_profile_id || req.query.rm_id || null;
  }

  const data = await service.getTodayPriorityList(orgId, rmProfileId);
  res.json({ success: true, data });
});

const getDashboardSummary = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const rmProfileId = req.wealthRole === 'rm' ? req.wealthRmProfile?.id : null;
  const data = await service.getDashboardSummary(orgId, req.wealthRole, rmProfileId);
  res.json({ success: true, data });
});

module.exports = { getDashboardToday, getDashboardSummary };
