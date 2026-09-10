'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/dashboard.controller');

const todayQuerySchema = z.object({
  rm_profile_id: z.string().uuid().optional(),
  rm_id:         z.string().uuid().optional(),
});

router.get(
  '/today',
  validate(todayQuerySchema, 'query'),
  ctrl.getDashboardToday
);

router.get('/summary', ctrl.getDashboardSummary);

module.exports = router;
