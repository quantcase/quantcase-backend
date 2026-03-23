'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/dashboard.service');

const getDashboardToday = asyncHandler(async (req, res) => {
  const { rm_id } = req.query;
  const data = await service.getTodayPriorityList(rm_id);
  res.json({ success: true, data });
});

module.exports = { getDashboardToday };
