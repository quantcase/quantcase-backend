const prisma       = require('../../config/prisma');
const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/heartbeat.service');

const getUserHeartbeat = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { id: true, display_name: true, email: true },
  });

  const data = await service.getUserHeartbeat(orgId, req.wealthMember, user, req.query);
  res.json({ success: true, data });
});

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
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { id: true, display_name: true, email: true },
  });
  const data = await service.getCioHeartbeat(orgId, req.wealthMember, user, req.query);
  res.json({ success: true, data });
});

module.exports = { getUserHeartbeat, getRmHeartbeat, getCioHeartbeat };
