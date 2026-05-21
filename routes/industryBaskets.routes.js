'use strict';

const router = require('express').Router();
const industryBasketsController = require('../controllers/industryBaskets.controller');

// GET /api/industry-baskets — list all baskets with latest IIT signal
router.get('/', industryBasketsController.getIndustryBaskets);

// GET /api/industry-baskets/:basketId/stocks — constituent stocks for a basket
// Query: page, size, sort, order
router.get('/:basketId/stocks', industryBasketsController.getIndustryBasketStocks);

module.exports = router;
