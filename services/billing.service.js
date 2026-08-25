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
  if (!price || !price.is_active || !price.razorpay_plan_id) {
    rzpLog('order ✗', { step: 'price-lookup', priceId, found: Boolean(price), isActive: price?.is_active });
    const err = new Error('Price not found, inactive, or missing razorpay_plan_id');
    err.status = 404;
    throw err;
  }
  rzpLog('order', { step: 'price-resolved', priceId, plan_id: price.razorpay_plan_id, plan_type: price.plan_type });

  let couponId = null;
  if (couponCode) {
    const couponResult = await validateCoupon(userId, couponCode, priceId);
    couponId = couponResult.coupon_id;
  }

  let subscription = await prisma.userSubscription.findUnique({ where: { user_id: userId } });

  if (!subscription) {
    subscription = await prisma.userSubscription.create({
      data: {
        user_id:   userId,
        price_id:  priceId,
        plan_type: price.plan_type,
        status:    'expired', // Starts expired/pending until autopay is setup
      },
    });
  }

  const rzp = getRazorpay();
  const startAt = Math.floor(Date.now() / 1000) + env.trialPeriodHours * 60 * 60;

  rzpLog('order →', {
    step: 'rzp.subscriptions.create',
    plan_id: price.razorpay_plan_id,
    start_at: startAt,
    subscription_id: subscription.id,
  });

  let rzpSub;
  try {
    rzpSub = await rzp.subscriptions.create({
      plan_id: price.razorpay_plan_id,
      total_count: 120,
      start_at: startAt,
      customer_notify: 1,
      notes: { subscription_id: subscription.id, user_id: userId, coupon_id: couponId || '' },
    });
  } catch (e) {
    rzpLog('order ✗', {
      step: 'rzp.subscriptions.create',
      statusCode: e?.statusCode,
      error:      e?.error || e?.description || e?.message,
    });
    throw e;
  }
  rzpLog('order ←', { step: 'rzp.subscriptions.create:ok', rzp_sub_id: rzpSub.id, status: rzpSub.status });

  await prisma.userSubscription.update({
    where: { id: subscription.id },
    data: { razorpay_subscription_id: rzpSub.id }
  });

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });

  rzpLog('order ←', {
    step: 'createSubscribeOrder:return',
    razorpay_subscription_id: rzpSub.id,
    mode:              getMode(),
  });

  return {
    razorpay_subscription_id: rzpSub.id,
    razorpay_key_id:   env.razorpayKeyId,
    mode:              getMode(),
    subscription_id:   subscription.id,
    prefill: {
      name:    user.profile?.full_name || user.display_name || '',
      email:   user.email || '',
      contact: user.profile?.phone || user.mobile || '',
    },
  };
}



// Step 1.5 of the Razorpay integration: verify the checkout handler's response
// server-side before treating the payment as genuine, then activate immediately.
// Uses the KEY secret (distinct from the webhook secret) and the documented
// HMAC(order_id + "|" + payment_id) construction.
async function verifyAndActivate(userId, { razorpay_subscription_id, razorpay_payment_id, razorpay_signature }) {
  rzpLog('verify →', {
    step: 'verifyAndActivate:start',
    userId, razorpay_subscription_id, razorpay_payment_id,
    signature: razorpay_signature ? `${String(razorpay_signature).slice(0, 8)}…(${razorpay_signature.length})` : null,
  });

  if (!env.razorpayKeySecret) {
    rzpLog('verify ✗', { step: 'key-secret-missing' });
    throw new Error('Razorpay credentials not configured');
  }

  // Razorpay subscription signature logic: payment_id + "|" + subscription_id
  const expected = crypto
    .createHmac('sha256', env.razorpayKeySecret)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
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
    rzpLog('verify ✗', { step: 'signature-mismatch', razorpay_subscription_id });
    const err = new Error('Invalid payment signature');
    err.status = 400;
    throw err;
  }

  const sub = await prisma.userSubscription.findUnique({ where: { razorpay_subscription_id } });
  if (!sub) {
    rzpLog('verify ✗', { step: 'subscription-not-found', razorpay_subscription_id });
    const err = new Error('Subscription not found');
    err.status = 404;
    throw err;
  }
  if (sub.user_id !== userId) {
    rzpLog('verify ✗', { step: 'user-mismatch', subUser: sub.user_id, reqUser: userId });
    const err = new Error('Subscription does not belong to this account');
    err.status = 403;
    throw err;
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + env.trialPeriodHours * 60 * 60 * 1000);

  // We set it to trialing here, actual payment charge comes 7 days later
  const updatedSub = await prisma.userSubscription.update({
    where: { id: sub.id },
    data: {
      status: 'trialing',
      trial_starts_at: now,
      trial_ends_at: trialEnd,
      current_period_end: trialEnd,
    }
  });

  rzpLog('verify ←', { step: 'verifyAndActivate:ok', subscription_id: sub.id, status: updatedSub.status });

  return {
    status:          updatedSub.status,
    subscription_id: updatedSub.id,
    current_period_end: updatedSub.current_period_end,
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
    subscription_id: payload?.subscription?.entity?.id || null,
    payment_id: payload?.payment?.entity?.id || null,
  });

  if (event === 'subscription.activated' || event === 'subscription.authenticated') {
    const rzpSub = payload.subscription?.entity;
    if (!rzpSub) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpay_subscription_id: rzpSub.id },
    });
    if (!sub) return;

    if (sub.status !== 'active') {
      const now = new Date();
      const trialEnd = new Date(now.getTime() + env.trialPeriodHours * 60 * 60 * 1000);
      await prisma.userSubscription.update({
        where: { id: sub.id },
        data: {
          status: 'trialing',
          trial_starts_at: now,
          trial_ends_at: trialEnd,
          current_period_end: trialEnd,
        },
      });
    }
    return;
  }

  if (event === 'subscription.charged') {
    const rzpSub = payload.subscription?.entity;
    const payment = payload.payment?.entity;
    if (!rzpSub || !payment) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpay_subscription_id: rzpSub.id },
    });
    if (!sub) return;

    let txn = await prisma.transaction.findUnique({ where: { razorpay_payment_id: payment.id } });
    if (!txn) {
      txn = await prisma.transaction.create({
        data: {
          subscription_id: sub.id,
          user_id: sub.user_id,
          razorpay_order_id: payment.order_id,
          razorpay_payment_id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          status: 'captured',
        }
      });
    } else if (txn.status !== 'captured') {
      await prisma.transaction.update({
        where: { id: txn.id },
        data: { status: 'captured' }
      });
    }

    const price = sub.price_id ? await prisma.price.findUnique({ where: { id: sub.price_id } }) : null;
    const intervalMonths = price?.interval_months || 1;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + intervalMonths);

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'active',
        plan_type: price?.plan_type || 'monthly',
        current_period_start: now,
        current_period_end: periodEnd,
      },
    });
    return;
  }

  if (event === 'subscription.halted' || event === 'subscription.cancelled') {
    const rzpSub = payload.subscription?.entity;
    if (!rzpSub) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpay_subscription_id: rzpSub.id },
    });
    if (!sub) return;

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data:  { 
        status: event === 'subscription.halted' ? 'past_due' : 'cancelled', 
        cancelled_at: event === 'subscription.cancelled' ? new Date() : sub.cancelled_at 
      },
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
