'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/actions.service');

const logAction = asyncHandler(async (req, res) => {
  const action = await service.logAction(req.body);
  res.status(201).json({ success: true, data: action });
});

module.exports = { logAction };
