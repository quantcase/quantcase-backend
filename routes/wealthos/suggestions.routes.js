'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/suggestions.controller');

const generateSchema = z.object({
  client_ids: z.array(z.string().uuid()).min(1).optional(),
  rm_id:      z.string().uuid().optional(),
}).refine(d => d.client_ids || d.rm_id, {
  message: 'Provide at least one of: client_ids, rm_id',
});

const statusSchema = z.object({
  status: z.enum(['used', 'ignored']),
  rm_id:  z.string().uuid().optional(),
});

router.post('/generate', validate(generateSchema, 'body'), ctrl.generateSuggestions);
router.put('/:suggestionId/status', validate(statusSchema, 'body'), ctrl.updateSuggestionStatus);

module.exports = router;
