'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const inviteService = require('../services/invite.service');

const createInvites = asyncHandler(async (req, res) => {
  const { emails } = req.body;
  const results = await inviteService.createInvites({ emails, invitedBy: req.user?.sub });
  res.status(201).json({ success: true, results });
});

module.exports = { createInvites };
