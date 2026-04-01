'use strict';

const router = require('express').Router();
const screenerController = require('../controllers/screener.controller');

// GET /api/screener/:symbol/technicals — technical data from Google Sheet watchlist
router.get('/:symbol/technicals', screenerController.getTechnicals);

// GET /api/screener/:symbol/financials — P&L, balance sheet, cash flow, TTM, metrics, valuation
router.get('/:symbol/financials', screenerController.getFinancials);

// GET /api/screener/:symbol/prices — day-wise OHLCV data (query: from, to as YYYY-MM-DD)
router.get('/:symbol/prices', screenerController.getPrices);

// GET /api/screener/:symbol/charts — chart-ready data grouped by Price, PE Ratio, Sales & Margin
router.get('/:symbol/charts', screenerController.getCharts);

// GET /api/screener/:symbol  — e.g. /api/screener/MSUMI or /api/screener/ABB
router.get('/:symbol', screenerController.getTickerInfo);

module.exports = router;
