'use strict';

const router = require('express').Router();
const basketsController = require('../controllers/baskets.controller');

// GET /api/baskets — list all basket definitions
router.get('/', basketsController.getBaskets);

// GET /api/baskets/:basketId/stocks — run screen for a basket, return matching stocks
// Query: page, size, sort, order
router.get('/:basketId/stocks', basketsController.getBasketStocks);

module.exports = router;
