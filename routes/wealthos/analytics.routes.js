'use strict';

const router = require('express').Router();
const ctrl   = require('../../controllers/wealthos/analytics.controller');

router.get('/rm/:rmId',  ctrl.getRmMetrics);
router.get('/clients',   ctrl.getClientSegmentation);

module.exports = router;
