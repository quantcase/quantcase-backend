'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/admin.invites.controller');

const createInvitesSchema = z.object({
  emails: z.array(z.string().email()).min(1),
});

// POST /admin/invites — bulk-create invites and email each recipient a signup link.
router.post('/', validate(createInvitesSchema, 'body'), ctrl.createInvites);

module.exports = router;
