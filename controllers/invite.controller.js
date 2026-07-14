'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const inviteService = require('../services/invite.service');

const validateInvite = asyncHandler(async (req, res) => {
  const { token } = req.query;
  const result = await inviteService.validateToken(token);
  res.json({ success: true, ...result });
});

module.exports = { validateInvite };
