'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/rm.controller');

const createRmSchema = z.object({
  name:              z.string().min(1),
  email:             z.string().email().optional(),
  team:              z.string().optional(),
  performance_score: z.number().min(0).max(100).optional(),
});

router.get('/',       ctrl.listRm);
router.post('/',      validate(createRmSchema, 'body'), ctrl.createRm);
router.get('/:rmId',  ctrl.getRmById);

module.exports = router;
