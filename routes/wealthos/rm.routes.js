'use strict';

const router            = require('express').Router();
const { z }             = require('zod');
const validate          = require('../../middleware/validate');
const requireWealthRole = require('../../middleware/requireWealthRole');
const ctrl              = require('../../controllers/wealthos/rm.controller');

const createRmSchema = z.object({
  email:         z.string().email(),
  display_name:  z.string().min(1),
  phone:         z.string().optional().nullable(),
  team:          z.string().optional().nullable(),
  target_aum_cr: z.number().min(0).optional().nullable(),
  notes:         z.string().optional().nullable(),
  password:      z.string().min(6).optional(),
});

// Listing and creating RMs is restricted to leadership
router.get('/',      requireWealthRole('cio', 'super_admin'), ctrl.listRm);
router.post('/',     requireWealthRole('super_admin'), validate(createRmSchema, 'body'), ctrl.createRm);
router.get('/:rmId', requireWealthRole('cio', 'super_admin'), ctrl.getRmById);

module.exports = router;
