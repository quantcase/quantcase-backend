'use strict';

const router            = require('express').Router();
const requireWealthRole = require('../../middleware/requireWealthRole');
const ctrl              = require('../../controllers/wealthos/heartbeat.controller');

// RM Heartbeat (all authenticated roles can access; RM scoped to self)
router.get('/rm/:rmProfileId', ctrl.getRmHeartbeat);

// CIO Heartbeat (macro 4-level view; restricted to CIO and Super Admin)
router.get('/cio', requireWealthRole('cio', 'super_admin'), ctrl.getCioHeartbeat);

module.exports = router;
