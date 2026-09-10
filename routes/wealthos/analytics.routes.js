'use strict';

const router            = require('express').Router();
const requireWealthRole = require('../../middleware/requireWealthRole');
const ctrl              = require('../../controllers/wealthos/analytics.controller');

router.get('/rm/:rmId',    ctrl.getRmMetrics);
router.get('/clients',     requireWealthRole('cio', 'super_admin'), ctrl.getClientSegmentation);
router.get('/summary',     requireWealthRole('cio', 'super_admin'), ctrl.getFirmSummary);

module.exports = router;
