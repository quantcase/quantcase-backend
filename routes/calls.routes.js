'use strict';

const router = require('express').Router();

const callsController   = require('../controllers/calls.controller');
const jobsController    = require('../controllers/jobs.controller');
const summaryController = require('../controllers/summary.controller');

// Collection
router.get('/',    callsController.getCalls);

// Single call
router.get('/:callId', callsController.getCallById);

// Nested summary
router.get('/:callId/summary', summaryController.getSummary);

// Job enqueue routes
router.post('/:callId/summarize-v2',     jobsController.enqueueSummarizationV2);
router.post('/:callId/summarize-v2-ppt', jobsController.enqueueSummarizationV2Ppt);

module.exports = router;
