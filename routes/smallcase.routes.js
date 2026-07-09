'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const authenticate = require('../middleware/authenticate');
const ctrl         = require('../controllers/smallcase.controller');

// Webhook — server-to-server, authenticated by checksum (not JWT). Must be registered
// BEFORE `router.use(authenticate)` and use a raw body parser for checksum verification.
router.post('/webhook', express.raw({ type: 'application/json' }), asyncHandler(ctrl.handleWebhook));

// All routes below require an authenticated QuantCase user.
router.use(authenticate);

router.post('/connect',                    asyncHandler(ctrl.connect));
router.post('/transactions/:id/confirm',   asyncHandler(ctrl.confirmTransaction));
router.post('/sync',                       asyncHandler(ctrl.syncHoldings));
router.get('/holdings',                    asyncHandler(ctrl.getHoldings));
router.get('/orders',                      asyncHandler(ctrl.getOrders));
router.post('/orders',                     asyncHandler(ctrl.createOrder));

module.exports = router;
