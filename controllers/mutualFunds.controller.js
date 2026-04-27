'use strict';

const asyncHandler       = require('../middleware/asyncHandler');
const mutualFundsService = require('../services/mutualFunds.service');

const listSchemes = asyncHandler(async (req, res) => {
  const { page, size, q, category, risk, rating, amc_slug, plan_type, sort, order } = req.query;
  const data = await mutualFundsService.listSchemes({ page, size, q, category, risk, rating, amc_slug, plan_type, sort, order });
  res.json({ success: true, ...data });
});

const getFilterOptions = asyncHandler(async (req, res) => {
  const data = await mutualFundsService.getFilterOptions();
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

module.exports = { listSchemes, getFilterOptions, getSchemeDetails };
