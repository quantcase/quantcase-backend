'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/opportunities.service');

const listOpportunities = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const result = await service.listOpportunities(
    orgId,
    req.query,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, ...result });
});

const createOpportunity = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const opp = await service.createOpportunity(
    orgId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.status(201).json({ success: true, data: opp });
});

const updateOpportunity = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const opp = await service.updateOpportunity(
    orgId,
    req.params.oppId,
    req.body,
    req.wealthRmProfile?.id,
    req.wealthMember.id
  );
  res.json({ success: true, data: opp });
});

const getOpportunitiesSummary = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const summary = await service.getOpportunitiesSummary(
    orgId,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: summary });
});

module.exports = { listOpportunities, getOpportunitiesSummary, createOpportunity, updateOpportunity };
