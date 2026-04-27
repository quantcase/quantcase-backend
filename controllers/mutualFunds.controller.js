'use strict';

const asyncHandler       = require('../middleware/asyncHandler');
const mutualFundsService = require('../services/mutualFunds.service');

const listSchemes = asyncHandler(async (req, res) => {
  const { page, size, category, amc_slug, plan_type } = req.query;
  const data = await mutualFundsService.listSchemes({ page, size, category, amc_slug, plan_type });
  res.json({ success: true, ...data });
});

const getSchemeDetails = asyncHandler(async (req, res) => {
  const { amfi_code } = req.params;
  const data = await mutualFundsService.getSchemeDetails(amfi_code);
  if (!data) {
    return res.status(404).json({ success: false, error: `Scheme ${amfi_code} not found.` });
  }
  res.json({ success: true, data });
});

module.exports = { listSchemes, getSchemeDetails };
