'use strict';

const { Router }           = require('express');
const analysisController   = require('../controllers/analysis.controller');

const router = Router();

// GET /api/analysis?callId=X&type=management,opportunity
router.get('/', analysisController.getAnalysis);

// POST /api/analysis  { callId, types: ['management','opportunity'], forceRefresh?: boolean }
router.post('/', analysisController.enqueueAnalysis);

module.exports = router;
