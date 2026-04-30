'use strict';

const router     = require('express').Router();
const controller = require('../controllers/industryIntelligence.controller');

// GET /api/industry-intelligence
//   ?industry=<basic_industry>  — populates deep_dive.selected_industry
//   ?cluster=<basic_industry>   — populates stock_ranking.selected_cluster
router.get('/', controller.getIndustryIntelligence);

module.exports = router;
