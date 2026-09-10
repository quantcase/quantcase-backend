'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/heartbeat.service');

const getRmHeartbeat = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const targetRmId = req.params.rmProfileId;

  // RMs can strictly only view their own heartbeat graph
  if (req.wealthRole === 'rm' && targetRmId !== req.wealthRmProfile?.id) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: RMs can only access their own heartbeat graph',
    });
  }

  const data = await service.getRmHeartbeat(orgId, targetRmId);
  res.json({ success: true, data });
});

const getCioHeartbeat = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.getCioHeartbeat(orgId, req.query);
  res.json({ success: true, data });
});

module.exports = { getRmHeartbeat, getCioHeartbeat };
