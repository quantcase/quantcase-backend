'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const opportunityController = require('../controllers/opportunity.controller');

router.get(
  '/analysis',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  opportunityController.getOFactorAnalysisByQuery
);

router.get(
  '/peer-data',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  opportunityController.getPeerData
);

router.get(
  '/prompt',
  validate(z.object({
    section: z.string().min(1, 'section is required'),
    callId:  z.string().optional(),
  })),
  opportunityController.getOFactorPrompt
);

module.exports = router;
