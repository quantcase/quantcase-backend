'use strict';

const router                = require('express').Router();
const mutualFundsController = require('../controllers/mutualFunds.controller');

// GET /api/mutual-funds?page=1&size=50&category=Flexi+Cap&amc_slug=hdfc-mutual-fund&plan_type=direct
router.get('/', mutualFundsController.listSchemes);

// GET /api/mutual-funds/:amfi_code
router.get('/:amfi_code', mutualFundsController.getSchemeDetails);

module.exports = router;
