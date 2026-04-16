'use strict';

const router = require('express').Router();

const callsController       = require('../controllers/calls.controller');
const jobsController        = require('../controllers/jobs.controller');
const opportunityController = require('../controllers/opportunity.controller');
const dealController        = require('../controllers/deal.controller');
const summaryController     = require('../controllers/summary.controller');

// Collection
router.get('/',    callsController.getCalls);

// Single call
router.get('/:callId', callsController.getCallById);

// Nested summary
router.get('/:callId/summary', summaryController.getSummary);

// Job enqueue routes
router.post('/:callId/summarize',                    jobsController.enqueueSummarization);
router.post('/:callId/extract-qe',                   jobsController.enqueueQeExtraction);
router.post('/:callId/opportunity/analysis/full',    jobsController.enqueueFullOpportunityAnalysis);

// Deal analysis
router.post('/:callId/deal/analysis', dealController.createDealAnalysis);
router.get('/:callId/deal',           dealController.getDealAnalysis);

// OFactor analysis result
router.get('/:callId/analysis', opportunityController.getOFactorAnalysis);

module.exports = router;
