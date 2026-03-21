'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/dashboard.controller');

router.get(
  '/today',
  validate(z.object({ rm_id: z.string().uuid() }), 'query'),
  ctrl.getDashboardToday
);

module.exports = router;
