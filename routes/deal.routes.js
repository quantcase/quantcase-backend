'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const dealController = require('../controllers/deal.controller');

router.get(
  '/analysis',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  dealController.getDealAnalysisByQuery
);

module.exports = router;
