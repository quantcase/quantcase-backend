'use strict';

const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../config/prisma');
const { googleClientId } = require('../config/env');
const { computeAccessState } = require('./subscription.service');
const inviteService = require('./invite.service');

const googleClient = new OAuth2Client(googleClientId);

async function register({ email, mobile, password, display_name, invite_token }) {
  if (!email && !mobile) {
    const err = new Error('Email or mobile is required');
    err.status = 400;
    throw err;
  }
  if (!password) {
    const err = new Error('Password is required');
    err.status = 400;
    throw err;
  }
  if (!invite_token) {
    const err = new Error('An invite token is required to register');
    err.status = 400;
    throw err;
  }

  // Throws (404/410) if the token is unknown, already used, or expired.
  const invite = await inviteService.validateToken(invite_token);
  if (email && invite.email !== email.trim().toLowerCase()) {
    const err = new Error('This invite was issued to a different email address');
    err.status = 403;
    throw err;
  }

  if (email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      const err = new Error('Email already in use');
      err.status = 409;
      throw err;
    }
  }
  if (mobile) {
    const existing = await prisma.user.findUnique({ where: { mobile } });
    if (existing) {
      const err = new Error('Mobile already in use');
      err.status = 409;
      throw err;
    }
  }

  const password_hash = await bcrypt.hash(password, 10);

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: email || null,
        mobile: mobile || null,
        password_hash,
        display_name: display_name || null,
        account_type: 'investor',
      },
    });

    await tx.userProfile.create({
      data: { user_id: created.id },
    });

    await tx.userSubscription.create({
      data: {
        user_id:             created.id,
        plan_type:           'trial',
        status:              'trialing',
        trial_starts_at:     now,
        trial_ends_at:       trialEnd,
        current_period_start: now,
        current_period_end:  trialEnd,
      },
    });

    // Consumes the invite so its token can't be reused for another signup.
    await tx.invite.update({
      where: { token: invite_token },
      data: { status: 'accepted', acceptedAt: now },
    });

    return created;
  });

  return user;
}

// Verifies the Google ID token the frontend obtained from Google Sign-In,
// then gates entry on the invite system: the verified email must have an
// active (pending or accepted) invite, same policy as email/password signup.
// - Existing user with this email: links google_id (first time) and signs in.
// - No existing user: creates one on the spot (no password_hash — Google-only
//   account) and accepts the invite, mirroring register()'s transaction.
async function googleAuth({ id_token }) {
  if (!id_token) {
    const err = new Error('id_token is required');
    err.status = 400;
    throw err;
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: googleClientId });
    payload = ticket.getPayload();
  } catch {
    const err = new Error('Invalid Google token');
    err.status = 401;
    throw err;
  }

  if (!payload?.email) {
    const err = new Error('Invalid Google token');
    err.status = 401;
    throw err;
  }
  if (!payload.email_verified) {
    const err = new Error('Google email is not verified');
    err.status = 403;
    throw err;
  }

  const email = payload.email.trim().toLowerCase();
  const googleId = payload.sub;
  const displayName = payload.name || null;
  const displayPicture = payload.picture || null;

  let user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    if (!user.google_id) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          google_id: googleId,
          display_name: user.display_name || displayName,
          display_picture: user.display_picture || displayPicture,
        },
      });
    }
    return user;
  }

  // Brand-new account — must have an active invite for this email.
  const invite = await inviteService.findActiveInviteForEmail(email);
  if (!invite) {
    const err = new Error('This is an invite-only platform. Ask an admin for an invite.');
    err.status = 403;
    throw err;
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        google_id: googleId,
        display_name: displayName,
        display_picture: displayPicture,
        account_type: 'investor',
      },
    });

    await tx.userProfile.create({ data: { user_id: created.id } });

    await tx.userSubscription.create({
      data: {
        user_id: created.id,
        plan_type: 'trial',
        status: 'trialing',
        trial_starts_at: now,
        trial_ends_at: trialEnd,
        current_period_start: now,
        current_period_end: trialEnd,
      },
    });

    if (invite.status !== 'accepted') {
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: 'accepted', acceptedAt: now },
      });
    }

    return created;
  });

  return user;
}

async function getFullProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      subscription: true,
      smallcase_user: { include: { _count: { select: { holdings: true } } } },
    },
  });

  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const accessState = computeAccessState(user.subscription, user.account_type);

  return {
    id:              user.id,
    email:           user.email,
    mobile:          user.mobile,
    account_type:    user.account_type,
    display_name:    user.display_name,
    display_picture: user.display_picture,
    created_at:      user.created_at,
    profile: user.profile
      ? {
          full_name:            user.profile.full_name,
          phone:                user.profile.phone,
          date_of_birth:        user.profile.date_of_birth,
          risk_profile:         user.profile.risk_profile,
          onboarding_completed: user.profile.onboarding_completed,
          onboarding_step:      user.profile.onboarding_step,
        }
      : null,
    subscription: user.subscription
      ? {
          plan_type:            user.subscription.plan_type,
          trial_starts_at:      user.subscription.trial_starts_at,
          trial_ends_at:        user.subscription.trial_ends_at,
          current_period_start: user.subscription.current_period_start,
          current_period_end:   user.subscription.current_period_end,
          ...accessState,
        }
      : null,
    smallcase: user.smallcase_user
      ? {
          is_connected:   user.smallcase_user.is_connected,
          broker:         user.smallcase_user.broker,
          last_synced_at: user.smallcase_user.last_synced_at,
          holdings_count: user.smallcase_user._count.holdings,
        }
      : { is_connected: false, broker: null, last_synced_at: null, holdings_count: 0 },
  };
}

// Maps integer step indices sent by the frontend to OnboardingStep enum values
const ONBOARDING_STEP_MAP = {
  1: 'profile',
  2: 'portfolio_setup',
  3: 'plan_selection',
  4: 'done',
  5: 'done',
};

async function updateOnboarding(userId, fields) {
  const {
    onboarding_step,
    onboarding_completed,
    full_name,
    phone,
    date_of_birth,
    risk_profile,
  } = fields;

  const data = {};
  if (onboarding_step !== undefined) {
    // Accept both integer (1-5 from frontend) and string enum values
    const stepValue = typeof onboarding_step === 'number'
      ? ONBOARDING_STEP_MAP[onboarding_step]
      : onboarding_step;
    if (!stepValue) {
      const err = new Error(`Invalid onboarding_step: ${onboarding_step}`);
      err.status = 400;
      throw err;
    }
    data.onboarding_step = stepValue;
    // Automatically mark completed when step reaches done
    if (stepValue === 'done') data.onboarding_completed = true;
  }
  if (onboarding_completed !== undefined) data.onboarding_completed = onboarding_completed;
  if (full_name            !== undefined) data.full_name            = full_name;
  if (phone                !== undefined) data.phone                = phone;
  if (date_of_birth        !== undefined) data.date_of_birth        = new Date(date_of_birth);
  if (risk_profile         !== undefined) data.risk_profile         = risk_profile;

  const profile = await prisma.userProfile.upsert({
    where:  { user_id: userId },
    create: { user_id: userId, ...data },
    update: data,
  });

  return profile;
}

module.exports = { register, googleAuth, getFullProfile, updateOnboarding };
