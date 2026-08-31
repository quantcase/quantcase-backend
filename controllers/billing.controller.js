'use strict';

const billingService    = require('../services/billing.service');
const subscriptionSvc   = require('../services/subscription.service');
const env               = require('../config/env');

// Public: lets the frontend read the active mode + publishable key id before a
// purchase (e.g. to show a "Test Mode" banner). The key id is public by design;
// only the secret stays server-side.
const getConfig = async (req, res) => {
  return res.json({
    success: true,
    data: { mode: billingService.getMode(), razorpay_key_id: env.razorpayKeyId },
  });
};

const getProducts = async (req, res) => {
  const products = await billingService.listProducts();
  return res.json({ success: true, data: products });
};

const getSubscription = async (req, res) => {
  const sub = await billingService.getSubscription(req.user.sub);
  if (!sub) return res.json({ success: true, data: null });

  const access = subscriptionSvc.computeAccessState(sub, req.user.accountType);
  return res.json({
    success: true,
    data: {
      id:                   sub.id,
      plan_type:            sub.plan_type,
      trial_starts_at:      sub.trial_starts_at,
      trial_ends_at:        sub.trial_ends_at,
      current_period_start: sub.current_period_start,
      current_period_end:   sub.current_period_end,
      razorpay_subscription_id: sub.razorpay_subscription_id,
      cancelled_at:         sub.cancelled_at,
      price:                sub.price,
      ...access,
    },
  });
};

const subscribe = async (req, res) => {
  const { price_id, coupon_code, gstin } = req.body;
  console.log('[razorpay ctrl →] POST /subscribe', JSON.stringify({ userId: req.user?.sub, price_id, coupon_code: coupon_code || null, gstin: gstin || null }));
  if (!price_id) {
    console.log('[razorpay ctrl ✗] POST /subscribe', 'price_id missing');
    return res.status(400).json({ error: 'price_id is required' });
  }

  const order = await billingService.createSubscribeOrder(req.user.sub, price_id, coupon_code, gstin);
  console.log('[razorpay ctrl ←] POST /subscribe', JSON.stringify({ razorpay_subscription_id: order.razorpay_subscription_id, mode: order.mode }));
  return res.status(201).json({ success: true, data: order });
};

const validateCoupon = async (req, res) => {
  const { code, price_id } = req.body;
  if (!code || !price_id) return res.status(400).json({ error: 'code and price_id are required' });

  const result = await billingService.validateCoupon(req.user.sub, code, price_id);
  return res.json({ success: true, data: result });
};

// Step 1.5: the checkout handler POSTs the payment result here for synchronous,
// server-side signature verification + immediate activation.
const verifyPayment = async (req, res) => {
  const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  console.log('[razorpay ctrl →] POST /verify', JSON.stringify({
    userId: req.user?.sub,
    razorpay_subscription_id, razorpay_payment_id,
    hasSignature: Boolean(razorpay_signature),
  }));
  if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
    console.log('[razorpay ctrl ✗] POST /verify', 'missing required field(s)');
    return res.status(400).json({
      error: 'razorpay_subscription_id, razorpay_payment_id and razorpay_signature are required',
    });
  }

  const result = await billingService.verifyAndActivate(req.user.sub, {
    razorpay_subscription_id,
    razorpay_payment_id,
    razorpay_signature,
  });
  console.log('[razorpay ctrl ←] POST /verify', JSON.stringify(result));
  return res.json({ success: true, data: result });
};

const handleWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody   = req.body;

  console.log('[razorpay ctrl →] POST /webhook', JSON.stringify({
    hasSignature: Boolean(signature),
    rawBodyIsBuffer: Buffer.isBuffer(rawBody),
    rawBodyLen: rawBody?.length || 0,
  }));

  if (!signature || !billingService.verifyWebhookSignature(rawBody, signature)) {
    console.log('[razorpay ctrl ✗] POST /webhook', 'invalid signature');
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.log('[razorpay ctrl ✗] POST /webhook', 'invalid JSON payload');
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  await billingService.handleWebhookEvent(parsed.event, parsed.payload || {});
  return res.json({ success: true });
};

const cancelSubscription = async (req, res) => {
  await billingService.cancelSubscription(req.user.sub, true);
  return res.json({ success: true, message: 'Subscription cancelled successfully' });
};

module.exports = { getConfig, getProducts, getSubscription, subscribe, validateCoupon, verifyPayment, handleWebhook, cancelSubscription };
