'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/suggestions.controller');

const generateSchema = z.object({
  client_ids:    z.array(z.string().uuid()).optional(),
  rm_profile_id: z.string().uuid().optional(),
  rm_id:         z.string().uuid().optional(),
});

const statusSchema = z.object({
  status:        z.enum(['used', 'ignored']),
  rm_profile_id: z.string().uuid().optional(),
  rm_id:         z.string().uuid().optional(),
});

router.post('/generate', validate(generateSchema, 'body'), ctrl.generateSuggestions);
router.put('/:suggestionId/status', validate(statusSchema, 'body'), ctrl.updateSuggestionStatus);

module.exports = router;
