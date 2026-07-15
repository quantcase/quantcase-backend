'use strict';

const prisma = require('../config/prisma');

async function getSubscriptionForUser(userId) {
  return prisma.userSubscription.findUnique({ where: { user_id: userId } });
}

function computeAccessState(subscription, accountType) {
  if (accountType === 'admin') {
    return { status: 'active', is_access_blocked: false, days_remaining: null };
  }

  if (!subscription) {
    return { status: null, is_access_blocked: true, days_remaining: 0 };
  }

  const now = new Date();

  if (subscription.status === 'trialing') {
    const trialEnd = subscription.trial_ends_at;
    if (trialEnd && trialEnd < now) {
      return { status: 'expired', is_access_blocked: true, days_remaining: 0 };
    }
    const ms = trialEnd ? trialEnd - now : 0;
    return {
      status: 'trialing',
      is_access_blocked: false,
      days_remaining: Math.max(0, Math.ceil(ms / 86400000)),
    };
  }

  if (subscription.status === 'active') {
    const periodEnd = subscription.current_period_end;
    if (periodEnd && periodEnd < now) {
      return { status: 'past_due', is_access_blocked: true, days_remaining: 0 };
    }
    const ms = periodEnd ? periodEnd - now : 0;
    return {
      status: 'active',
      is_access_blocked: false,
      days_remaining: Math.max(0, Math.ceil(ms / 86400000)),
    };
  }

  return { status: subscription.status, is_access_blocked: true, days_remaining: 0 };
}

module.exports = { getSubscriptionForUser, computeAccessState };
