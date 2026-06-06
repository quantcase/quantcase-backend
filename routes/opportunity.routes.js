'use strict';

const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getFinancialStrength } = require('../services/financialStrength.service');

const router = Router();

// GET /api/opportunity/financial-strength?ticker=IEX
router.get('/financial-strength', asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const data = await getFinancialStrength(ticker);
  if (!data.available) {
    return res.status(404).json({ success: false, ...data });
  }
  res.json({ success: true, data });
}));

module.exports = router;
