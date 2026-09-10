'use strict';

const router = require('express').Router();
const ctrl   = require('../../controllers/wealthos/export.controller');

router.get('/clients',  ctrl.exportClients);
router.get('/holdings', ctrl.exportHoldings);

module.exports = router;
