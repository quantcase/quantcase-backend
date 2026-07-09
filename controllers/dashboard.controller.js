'use strict';

const asyncHandler       = require('../middleware/asyncHandler');
const discoverSvc        = require('../services/dashboard/discover-screens.service');
const researchLibrarySvc = require('../services/dashboard/research-library.service');
const marketIndicesSvc   = require('../services/dashboard/market-indices.service');

const getDiscoverScreens = asyncHandler(async (req, res) => {
  const data = await discoverSvc.getDiscoverScreens(req.user.sub);
  res.json({ success: true, data });
});

const getResearchLibrarySummary = asyncHandler(async (req, res) => {
  const data = await researchLibrarySvc.getResearchLibrarySummary(req.user.sub);
  res.json({ success: true, data });
});

const getMarketIndices = asyncHandler(async (_req, res) => {
  const data = await marketIndicesSvc.getMarketIndices();
  res.json({ success: true, data });
});

module.exports = { getDiscoverScreens, getResearchLibrarySummary, getMarketIndices };
