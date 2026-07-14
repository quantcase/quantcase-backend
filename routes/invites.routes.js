'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/invite.controller');

const validateQuerySchema = z.object({
  token: z.string().min(1),
});

// GET /api/invites/validate?token=... — frontend calls this before showing
// the registration form to confirm the invite is still pending/unexpired.
router.get('/validate', validate(validateQuerySchema, 'query'), ctrl.validateInvite);

module.exports = router;
