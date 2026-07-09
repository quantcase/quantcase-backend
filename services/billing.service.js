'use strict';

const crypto  = require('crypto');
const Razorpay = require('razorpay');
const prisma  = require('../config/prisma');
const env     = require('../config/env');

// ─── DEBUG helper: single-line, secret-safe log for the Razorpay flow ─────────
// Toggle off by setting env RAZORPAY_DEBUG=false. Never logs the key/webhook
// secret or full signatures — only presence/length/prefix so logs stay shareable.
function rzpLog(tag, data) {
  if (env.razorpayDebug === false) return;
  console.log(`[razorpay ${tag}]`, JSON.stringify(data ?? {}, null, 2));
}

function getRazorpay() {
  rzpLog('config', {
    keyId:            env.razorpayKeyId ? `${String(env.razorpayKeyId).slice(0, 12)}…` : null,
    keySecretSet:     Boolean(env.razorpayKeySecret),
    keySecretLen:     env.razorpayKeySecret?.length || 0,
    webhookSecretSet: Boolean(env.razorpayWebhookSecret),
    mode:             getMode(),
  });
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    rzpLog('config-error', { message: 'Razorpay credentials not configured' });
    throw new Error('Razorpay credentials not configured');
  }
  return new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
}

// Derives the active Razorpay environment from the configured key id prefix.
// The frontend uses this to branch (e.g. show a "Test Mode" banner); flipping the
// key id in .env flips the whole app between test and live.
function getMode() {
  return (env.razorpayKeyId || '').startsWith('rzp_live_') ? 'live' : 'test';
}

async function listProducts() {
  return prisma.product.findMany({
    where: { is_active: true },
    include: {
      prices: {
        where: { is_active: true },
        select: { id: true, plan_type: true, amount: true, currency: true, interval_months: true, razorpay_plan_id: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });
}

async function getSubscription(userId) {
  const sub = await prisma.userSubscription.findUnique({
    where: { user_id: userId },
    include: { price: { include: { product: true } } },
  });
  return sub;
}

async function validateCoupon(userId, code, priceId) {
  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.is_active) {
    const err = new Error('Coupon not found or inactive');
    err.status = 404;
    throw err;
  }

  const now = new Date();
  if (coupon.expires_at && coupon.expires_at < now) {
    const err = new Error('Coupon has expired');
    err.status = 422;
    throw err;
  }
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
    const err = new Error('Coupon usage limit reached');
    err.status = 422;
    throw err;
  }

  const alreadyUsed = await prisma.discount.findUnique({
    where: { coupon_id_user_id: { coupon_id: coupon.id, user_id: userId } },
  });
  if (alreadyUsed) {
    const err = new Error('Coupon already used by this account');
    err.status = 422;
    throw err;
  }

  const price = await prisma.price.findUnique({ where: { id: priceId } });
  if (!price) {
    const err = new Error('Price not found');
    err.status = 404;
    throw err;
  }

  const originalAmount = price.amount;
  let discountedAmount;
  if (coupon.discount_type === 'percentage') {
    discountedAmount = Math.round(originalAmount * (1 - Number(coupon.discount_value) / 100));
  } else {
    discountedAmount = Math.max(0, originalAmount - Number(coupon.discount_value) * 100);
  }

  return {
    coupon_id:          coupon.id,
    code:               coupon.code,
    discount_type:      coupon.discount_type,
    discount_value:     coupon.discount_value,
    original_amount:    originalAmount,
    discounted_amount:  discountedAmount,
  };
}

async function createSubscribeOrder(userId, priceId, couponCode) {
  rzpLog('order →', { step: 'createSubscribeOrder:start', userId, priceId, couponCode: couponCode || null });

  const price = await prisma.price.findUnique({
    where: { id: priceId },
    include: { product: true },
  });
  if (!price || !price.is_active) {
    rzpLog('order ✗', { step: 'price-lookup', priceId, found: Boolean(price), isActive: price?.is_active });
    const err = new Error('Price not found or inactive');
    err.status = 404;
    throw err;
  }
  rzpLog('order', { step: 'price-resolved', priceId, amount: price.amount, currency: price.currency, plan_type: price.plan_type });

  let finalAmount = price.amount;
  let couponId = null;

  if (couponCode) {
    const couponResult = await validateCoupon(userId, couponCode, priceId);
    finalAmount = couponResult.discounted_amount;
    couponId = couponResult.coupon_id;
  }

  const rzp = getRazorpay();

  let subscription = await prisma.userSubscription.findUnique({ where: { user_id: userId } });

  if (!subscription) {
    subscription = await prisma.userSubscription.create({
      data: {
        user_id:   userId,
        price_id:  priceId,
        plan_type: price.plan_type,
        status:    'trialing',
      },
    });
  }

  const receiptId = `sub_${subscription.id.replace(/-/g, '').slice(0, 20)}`;
  rzpLog('order →', {
    step: 'rzp.orders.create',
    amount: finalAmount, currency: price.currency, receipt: receiptId,
    subscription_id: subscription.id,
  });

  let rzpOrder;
  try {
    rzpOrder = await rzp.orders.create({
      amount:   finalAmount,
      currency: price.currency,
      receipt:  receiptId,
      notes:    { subscription_id: subscription.id, user_id: userId, coupon_id: couponId || '' },
    });
  } catch (e) {
    // Razorpay SDK errors carry statusCode + error.description; surface both so a
    // frontend "Payment Failed" can be traced to the real Razorpay rejection.
    rzpLog('order ✗', {
      step: 'rzp.orders.create',
      statusCode: e?.statusCode,
      error:      e?.error || e?.description || e?.message,
    });
    throw e;
  }
  rzpLog('order ←', { step: 'rzp.orders.create:ok', order_id: rzpOrder.id, status: rzpOrder.status, amount: rzpOrder.amount });

  await prisma.transaction.create({
    data: {
      subscription_id:   subscription.id,
      user_id:           userId,
      razorpay_order_id: rzpOrder.id,
      amount:            finalAmount,
      currency:          price.currency,
      status:            'pending',
      metadata:          { price_id: priceId, coupon_id: couponId },
    },
  });

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });

  rzpLog('order ←', {
    step: 'createSubscribeOrder:return',
    razorpay_order_id: rzpOrder.id,
    razorpay_key_id:   env.razorpayKeyId ? `${String(env.razorpayKeyId).slice(0, 12)}…` : null,
    mode:              getMode(),
    amount:            finalAmount,
    currency:          price.currency,
  });

  return {
    razorpay_order_id: rzpOrder.id,
    razorpay_key_id:   env.razorpayKeyId,
    mode:              getMode(),
    amount:            finalAmount,
    currency:          price.currency,
    subscription_id:   subscription.id,
    prefill: {
      name:    user.profile?.full_name || user.display_name || '',
      email:   user.email || '',
      contact: user.profile?.phone || user.mobile || '',
    },
  };
}

// Shared "capture + activate" path used by BOTH the payment.captured webhook and
// the synchronous /verify endpoint. Idempotent: if the transaction is already
// captured it returns without re-activating or double-counting the coupon, so the
// two callers compose safely when both fire for the same payment.
async function activateFromCapturedTransaction(txn, paymentId) {
  if (txn.status === 'captured') {
    return prisma.userSubscription.findUnique({ where: { id: txn.subscription_id } });
  }

  await prisma.transaction.update({
    where: { id: txn.id },
    data:  { status: 'captured', razorpay_payment_id: paymentId },
  });

  const now = new Date();
  const sub = await prisma.userSubscription.findUnique({ where: { id: txn.subscription_id } });
  if (!sub) return null;

  const price = sub.price_id ? await prisma.price.findUnique({ where: { id: sub.price_id } }) : null;
  const intervalMonths = price?.interval_months || 1;
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + intervalMonths);

  const updatedSub = await prisma.userSubscription.update({
    where: { id: sub.id },
    data: {
      status:               'active',
      plan_type:            price?.plan_type || 'monthly',
      current_period_start: now,
      current_period_end:   periodEnd,
      trial_ends_at:        sub.trial_ends_at || now,
    },
  });

  const metadata = txn.metadata || {};
  if (metadata.coupon_id) {
    const coupon = await prisma.coupon.findUnique({ where: { id: metadata.coupon_id } });
    if (coupon) {
      await prisma.$transaction([
        prisma.discount.create({
          data: { coupon_id: coupon.id, user_id: txn.user_id },
        }),
        prisma.coupon.update({
          where: { id: coupon.id },
          data:  { used_count: { increment: 1 } },
        }),
      ]);
    }
  }

  return updatedSub;
}

// Step 1.5 of the Razorpay integration: verify the checkout handler's response
// server-side before treating the payment as genuine, then activate immediately.
// Uses the KEY secret (distinct from the webhook secret) and the documented
// HMAC(order_id + "|" + payment_id) construction.
async function verifyAndActivate(userId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  rzpLog('verify →', {
    step: 'verifyAndActivate:start',
    userId, razorpay_order_id, razorpay_payment_id,
    // Only prefix + length of the signature — enough to confirm it arrived, safe to share.
    signature: razorpay_signature ? `${String(razorpay_signature).slice(0, 8)}…(${razorpay_signature.length})` : null,
  });

  if (!env.razorpayKeySecret) {
    rzpLog('verify ✗', { step: 'key-secret-missing' });
    throw new Error('Razorpay credentials not configured');
  }

  const expected = crypto
    .createHmac('sha256', env.razorpayKeySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));
  } catch {
    valid = false;
  }
  rzpLog('verify', {
    step: 'signature-check',
    valid,
    expectedPrefix: `${expected.slice(0, 8)}…`,
    gotPrefix:      razorpay_signature ? `${String(razorpay_signature).slice(0, 8)}…` : null,
  });
  if (!valid) {
    rzpLog('verify ✗', { step: 'signature-mismatch', razorpay_order_id });
    const err = new Error('Invalid payment signature');
    err.status = 400;
    throw err;
  }

  const txn = await prisma.transaction.findUnique({ where: { razorpay_order_id } });
  if (!txn) {
    rzpLog('verify ✗', { step: 'transaction-not-found', razorpay_order_id });
    const err = new Error('Transaction not found for this order');
    err.status = 404;
    throw err;
  }
  if (txn.user_id !== userId) {
    rzpLog('verify ✗', { step: 'user-mismatch', txnUser: txn.user_id, reqUser: userId });
    const err = new Error('Order does not belong to this account');
    err.status = 403;
    throw err;
  }

  const sub = await activateFromCapturedTransaction(txn, razorpay_payment_id);
  rzpLog('verify ←', { step: 'verifyAndActivate:ok', subscription_id: txn.subscription_id, status: sub?.status });

  return {
    status:          sub?.status || 'active',
    subscription_id: txn.subscription_id,
    current_period_end: sub?.current_period_end || null,
  };
}

function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', env.razorpayWebhookSecret)
    .update(rawBody)
    .digest('hex');
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    ok = false;
  }
  rzpLog('webhook', {
    step: 'signature-check',
    ok,
    webhookSecretSet: Boolean(env.razorpayWebhookSecret),
    rawBodyLen: rawBody?.length || 0,
    gotSignaturePrefix: signature ? `${String(signature).slice(0, 8)}…` : null,
  });
  return ok;
}

async function handleWebhookEvent(event, payload) {
  rzpLog('webhook →', {
    step: 'event',
    event,
    order_id: payload?.payment?.entity?.order_id || payload?.subscription?.entity?.id || null,
    payment_id: payload?.payment?.entity?.id || null,
  });
  if (event === 'payment.captured') {
    const payment = payload.payment?.entity;
    if (!payment) return;

    const txn = await prisma.transaction.findUnique({
      where: { razorpay_order_id: payment.order_id },
    });
    if (!txn) return;

    await activateFromCapturedTransaction(txn, payment.id);
    return;
  }

  if (event === 'payment.failed') {
    const payment = payload.payment?.entity;
    if (!payment) return;

    const txn = await prisma.transaction.findUnique({
      where: { razorpay_order_id: payment.order_id },
    });
    if (!txn) return;

    await prisma.transaction.update({
      where: { id: txn.id },
      data:  { status: 'failed', failure_reason: payment.error_description || 'Payment failed' },
    });

    if (txn.subscription_id) {
      await prisma.userSubscription.update({
        where: { id: txn.subscription_id },
        data:  { status: 'past_due' },
      });
    }
    return;
  }

  if (event === 'subscription.cancelled') {
    const rzpSub = payload.subscription?.entity;
    if (!rzpSub) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpay_subscription_id: rzpSub.id },
    });
    if (!sub) return;

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data:  { status: 'cancelled', cancelled_at: new Date() },
    });
  }
}

module.exports = {
  getMode,
  listProducts,
  getSubscription,
  validateCoupon,
  createSubscribeOrder,
  verifyAndActivate,
  verifyWebhookSignature,
  handleWebhookEvent,
};
