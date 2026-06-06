'use strict';

const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getTargetPriceMatrix } = require('../services/targetPriceMatrix.service');
const { getEarningsForecast }  = require('../services/earningsForecast.service');
const { getEarningsQuality }       = require('../services/earningsQuality.service');
const { getPeReratingPotential }   = require('../services/peReratingPotential.service');

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

// GET /api/deal/earnings-forecast?ticker=IEX
router.get('/earnings-forecast', asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const data = await getEarningsForecast(ticker);
  if (!data.available) {
    return res.status(404).json({ success: false, ...data });
  }
  res.json({ success: true, data });
}));

// GET /api/deal/earnings-quality?ticker=TCS
router.get('/earnings-quality', asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const data = await getEarningsQuality(ticker);
  if (!data.available) {
    return res.status(404).json({ success: false, ...data });
  }
  res.json({ success: true, data });
}));

// GET /api/deal/pe-rerating-potential?ticker=TCS
router.get('/pe-rerating-potential', asyncHandler(async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const data = await getPeReratingPotential(ticker);
  if (!data.available) return res.status(404).json({ success: false, ...data });
  res.json({ success: true, data });
}));

module.exports = router;
