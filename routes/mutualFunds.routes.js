'use strict';

const router                    = require('express').Router();
const asyncHandler              = require('../middleware/asyncHandler');
const mutualFundsController     = require('../controllers/mutualFunds.controller');
const mfBasketsController       = require('../controllers/mutualFundsBaskets.controller');

// GET /api/mutual-funds?page=1&size=50&q=hdfc&category=Flexi+Cap,Large+Cap&risk=High,Very+High&rating=4&amc_slug=hdfc-mutual-fund&plan_type=Direct&sort=returns_1y&order=desc
router.get('/', mutualFundsController.listSchemes);

// GET /api/mutual-funds/filter-options — distinct values for filter dropdowns
router.get('/filter-options', mutualFundsController.getFilterOptions);

// ── Basket routes (must come before /:amfi_code to avoid shadowing) ──────────

// GET /api/mutual-funds/baskets — list all basket definitions
router.get('/baskets', mfBasketsController.getMFBaskets);

// GET /api/mutual-funds/baskets/:basketId/schemes — run screener for a basket
router.get('/baskets/:basketId/schemes', asyncHandler(mfBasketsController.getMFBasketSchemes));

// ── Scheme detail ─────────────────────────────────────────────────────────────

// GET /api/mutual-funds/:amfi_code
router.get('/:amfi_code', mutualFundsController.getSchemeDetails);

module.exports = router;
