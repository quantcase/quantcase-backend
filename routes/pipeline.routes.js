'use strict';

const { Router } = require('express');
const { getCoverage, getMissing } = require('../controllers/pipeline.controller');

const router = Router();

// GET /api/pipeline/coverage — L1 signal coverage per source type
router.get('/coverage', getCoverage);

// GET /api/pipeline/missing?source=transcript|ppt|annual_report — list of unprocessed eligible rows
router.get('/missing', getMissing);

module.exports = router;
