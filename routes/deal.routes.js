'use strict';

const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getTargetPriceMatrix } = require('../services/targetPriceMatrix.service');

const router = Router();

// GET /api/deal/target-price-matrix?ticker=MSUMI
router.get('/target-price-matrix', asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const data = await getTargetPriceMatrix(ticker);
  if (!data.available) {
    return res.status(404).json({ success: false, ...data });
  }
  res.json({ success: true, data });
}));

module.exports = router;
