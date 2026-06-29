'use strict';

const { getSubscriptionForUser, computeAccessState } = require('../services/subscription.service');

const requireActiveSubscription = async (req, res, next) => {
  const subscription = await getSubscriptionForUser(req.user.sub);
  const access = computeAccessState(subscription, req.user.accountType);

  if (access.is_access_blocked) {
    return res.status(403).json({
      error: 'Subscription required',
      subscription_status: access.status,
      days_remaining: access.days_remaining,
    });
  }

  next();
};

module.exports = requireActiveSubscription;
