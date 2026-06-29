'use strict';

const router       = require('express').Router();
const asyncHandler = require('../middleware/asyncHandler');
const authenticate = require('../middleware/authenticate');
const ctrl         = require('../controllers/smallcase.controller');

router.use(authenticate);

router.post('/auth',   asyncHandler(ctrl.storeAuth));
router.get('/holdings', asyncHandler(ctrl.getHoldings));
router.get('/orders',   asyncHandler(ctrl.getOrders));
router.post('/sync',    asyncHandler(ctrl.syncHoldings));

module.exports = router;
