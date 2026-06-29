'use strict';

const crypto  = require('crypto');
const Razorpay = require('razorpay');
const prisma  = require('../config/prisma');
const env     = require('../config/env');

function getRazorpay() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new Error('Razorpay credentials not configured');
  }
  return new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
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
  const price = await prisma.price.findUnique({
    where: { id: priceId },
    include: { product: true },
  });
  if (!price || !price.is_active) {
    const err = new Error('Price not found or inactive');
    err.status = 404;
    throw err;
  }

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
  const rzpOrder = await rzp.orders.create({
    amount:   finalAmount,
    currency: price.currency,
    receipt:  receiptId,
    notes:    { subscription_id: subscription.id, user_id: userId, coupon_id: couponId || '' },
  });

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

  return {
    razorpay_order_id: rzpOrder.id,
    razorpay_key_id:   env.razorpayKeyId,
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

function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', env.razorpayWebhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function handleWebhookEvent(event, payload) {
  if (event === 'payment.captured') {
    const payment = payload.payment?.entity;
    if (!payment) return;

    const txn = await prisma.transaction.findUnique({
      where: { razorpay_order_id: payment.order_id },
    });
    if (!txn) return;

    await prisma.transaction.update({
      where: { id: txn.id },
      data:  { status: 'captured', razorpay_payment_id: payment.id },
    });

    const now = new Date();
    const sub = await prisma.userSubscription.findUnique({ where: { id: txn.subscription_id } });
    if (!sub) return;

    const price = sub.price_id ? await prisma.price.findUnique({ where: { id: sub.price_id } }) : null;
    const intervalMonths = price?.interval_months || 1;
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + intervalMonths);

    await prisma.userSubscription.update({
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
  listProducts,
  getSubscription,
  validateCoupon,
  createSubscribeOrder,
  verifyWebhookSignature,
  handleWebhookEvent,
};
