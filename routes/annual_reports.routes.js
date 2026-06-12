'use strict';

const router         = require('express').Router();
const jobsController = require('../controllers/jobs.controller');

// Enqueue signal extraction for a single annual report PDF
router.post('/:reportId/summarize-v2', jobsController.enqueueSummarizationV2AnnualReport);

module.exports = router;
