'use strict';

const router            = require('express').Router();
const { z }             = require('zod');
const validate          = require('../../middleware/validate');
const requireWealthRole = require('../../middleware/requireWealthRole');
const ctrl              = require('../../controllers/wealthos/models.controller');

const createModelSchema = z.object({
  name:              z.string().min(1),
  description:       z.string().optional().nullable(),
  model_type:        z.enum(['equity', 'debt', 'hybrid', 'structured', 'pms', 'aif']),
  version:           z.string().optional().default('1.0'),
  min_investment_cr: z.number().min(0).optional().nullable(),
  is_published:      z.boolean().optional().default(false),
  data:              z.record(z.string(), z.unknown()).optional(),
});

router.get('/', ctrl.listModels);
router.get('/:modelId', ctrl.getModelById);
router.post(
  '/',
  requireWealthRole('cio', 'super_admin'),
  validate(createModelSchema, 'body'),
  ctrl.createModel
);
router.put(
  '/:modelId/publish',
  requireWealthRole('cio', 'super_admin'),
  ctrl.publishModel
);

module.exports = router;
