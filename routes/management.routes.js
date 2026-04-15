'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate           = require('../middleware/validate');
const managementController = require('../controllers/management.controller');

router.get(
  '/analysis',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  managementController.getManagementAnalysis
);

router.post(
  '/:callId/analyze',
  managementController.createManagementAnalysis
);

module.exports = router;
