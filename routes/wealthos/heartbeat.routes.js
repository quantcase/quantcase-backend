'use strict';

const router            = require('express').Router();
const requireWealthRole = require('../../middleware/requireWealthRole');
const ctrl              = require('../../controllers/wealthos/heartbeat.controller');

// Auto-detect logged in user role and return their personalized Heartbeat graph
// (RM at center for RMs, CIO at center for CIO, Super Admin at center for Admin)
router.get('/', ctrl.getUserHeartbeat);
router.get('/me', ctrl.getUserHeartbeat);

// Specific RM Heartbeat (all authenticated roles can access; RM scoped to self)
router.get('/rm/:rmProfileId', ctrl.getRmHeartbeat);

// Specific CIO Heartbeat (macro 4-level view; restricted to CIO and Super Admin)
router.get('/cio', requireWealthRole('cio', 'super_admin'), ctrl.getCioHeartbeat);

module.exports = router;
