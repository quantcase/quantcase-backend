'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/actions.controller');

const logActionSchema = z.object({
  suggestion_id: z.string().uuid().optional(),
  client_id:     z.string().uuid(),
  rm_id:         z.string().uuid().optional(),
  action_type:   z.string().min(1),
  content:       z.string().optional(),
  outcome:       z.string().optional(),
});

router.post('/', validate(logActionSchema, 'body'), ctrl.logAction);

module.exports = router;
