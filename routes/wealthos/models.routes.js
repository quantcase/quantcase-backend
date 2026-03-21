'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/models.controller');

const createModelSchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional(),
  model_type:  z.enum(['equity', 'debt', 'hybrid', 'structured', 'pms', 'aif']),
  data:        z.record(z.unknown()).optional(),
});

router.get('/',  ctrl.listModels);
router.post('/', validate(createModelSchema, 'body'), ctrl.createModel);

module.exports = router;
