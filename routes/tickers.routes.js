'use strict';

const router = require('express').Router();
const tickersController = require('../controllers/tickers.controller');

// GET  /api/tickers?tickers=TCS,INFY — batch metrics for a caller-supplied ticker list
router.get('/', tickersController.getTickers);

// POST /api/tickers  { "tickers": ["TCS","INFY"] } — same, for lists too long for a query string
router.post('/', tickersController.getTickers);

module.exports = router;
