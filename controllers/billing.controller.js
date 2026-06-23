'use strict';

const billingService    = require('../services/billing.service');
const subscriptionSvc   = require('../services/subscription.service');

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
      price:                sub.price,
      ...access,
    },
  });
};

const subscribe = async (req, res) => {
  const { price_id, coupon_code } = req.body;
  if (!price_id) return res.status(400).json({ error: 'price_id is required' });

  const order = await billingService.createSubscribeOrder(req.user.sub, price_id, coupon_code);
  return res.status(201).json({ success: true, data: order });
};

const validateCoupon = async (req, res) => {
  const { code, price_id } = req.body;
  if (!code || !price_id) return res.status(400).json({ error: 'code and price_id are required' });

  const result = await billingService.validateCoupon(req.user.sub, code, price_id);
  return res.json({ success: true, data: result });
};

const handleWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody   = req.body;

  if (!signature || !billingService.verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  await billingService.handleWebhookEvent(parsed.event, parsed.payload || {});
  return res.json({ success: true });
};

module.exports = { getProducts, getSubscription, subscribe, validateCoupon, handleWebhook };
