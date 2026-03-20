'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const adminController = require('../controllers/admin.controller');

router.get(
  '/opportunity/stats',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  adminController.getOpportunityStats
);

module.exports = router;
