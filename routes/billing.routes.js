'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const authenticate = require('../middleware/authenticate');
const ctrl         = require('../controllers/billing.controller');

router.get('/config',             asyncHandler(ctrl.getConfig));
router.get('/products',           asyncHandler(ctrl.getProducts));
router.get('/subscription',       authenticate, asyncHandler(ctrl.getSubscription));
router.post('/subscribe',         authenticate, asyncHandler(ctrl.subscribe));
router.post('/coupons/validate',  authenticate, asyncHandler(ctrl.validateCoupon));
router.post('/verify',            authenticate, asyncHandler(ctrl.verifyPayment));
router.post('/subscription/cancel', authenticate, asyncHandler(ctrl.cancelSubscription));

// Webhook must receive raw body for HMAC verification — express.raw() overrides express.json() for this route
router.post('/webhook', express.raw({ type: 'application/json' }), asyncHandler(ctrl.handleWebhook));

module.exports = router;
