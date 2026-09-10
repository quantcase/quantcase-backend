'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/actions.controller');

const logActionSchema = z.object({
  suggestion_id: z.string().uuid().optional().nullable(),
  client_id:     z.string().uuid(),
  rm_profile_id: z.string().uuid().optional().nullable(),
  rm_id:         z.string().uuid().optional().nullable(),
  action_type:   z.string().min(1),
  content:       z.string().optional().nullable(),
  outcome:       z.string().optional().nullable(),
});

router.post('/', validate(logActionSchema, 'body'), ctrl.logAction);

module.exports = router;
