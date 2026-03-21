'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const callsController = require('../controllers/calls.controller');

router.get('/stocks', callsController.getTranscriptStocks);

router.get(
  '/calls',
  validate(z.object({ symbol: z.string().min(1, 'symbol is required') })),
  callsController.getTranscriptCalls
);

module.exports = router;
