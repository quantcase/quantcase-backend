'use strict';

const crypto = require('crypto');
const prisma = require('../config/prisma');
const { sendMail } = require('../lib/mailer');
const { inviteEmail } = require('../utils/emailTemplates/invite');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildInviteUrl(token) {
  const base = process.env.FRONTEND_INVITE_URL || 'https://beta.quantcase.ai';
  const url = new URL(base);
  url.searchParams.set('invite_token', token);
  return url.toString();
}

// Creates one Invite row per email (skips emails that already have a pending,
// unexpired invite) and emails each recipient. Partial failures (e.g. one bad
// email address) don't abort the batch — each result reports its own outcome.
async function createInvites({ emails, invitedBy }) {
  const uniqueEmails = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!uniqueEmails.length) {
    throw new HttpError(400, 'At least one email is required');
  }

  const now = new Date();

  const results = [];
  for (const email of uniqueEmails) {
    const existing = await prisma.invite.findFirst({
      where: { email, status: 'pending', expiresAt: { gt: now } },
    });

    const invite = existing
      || (await prisma.invite.create({
        data: {
          email,
          token: generateToken(),
          invitedBy: invitedBy || null,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
      }));

    try {
      const { subject, html, text } = inviteEmail({ inviteUrl: buildInviteUrl(invite.token) });
      await sendMail({ to: email, subject, html, text });
      results.push({ email, status: 'sent', inviteId: invite.id, resent: Boolean(existing) });
    } catch (err) {
      results.push({ email, status: 'failed', reason: err.message, inviteId: invite.id, resent: Boolean(existing) });
    }
  }

  return results;
}

async function validateToken(token) {
  if (!token) throw new HttpError(400, 'token is required');

  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) throw new HttpError(404, 'Invite not found');

  if (invite.status === 'accepted') {
    throw new HttpError(410, 'Invite has already been used');
  }
  if (invite.status === 'expired' || invite.expiresAt < new Date()) {
    if (invite.status !== 'expired') {
      await prisma.invite.update({ where: { id: invite.id }, data: { status: 'expired' } });
    }
    throw new HttpError(410, 'Invite has expired');
  }

  return { email: invite.email, expiresAt: invite.expiresAt };
}

// Looks up the most recent non-expired invite for an email without a token —
// used by Google sign-in, where there's no invite_token in hand, only the
// email Google verified. Accepts 'pending' (first-ever login accepts it, same
// as the email flow) or 'accepted' (already used by a prior email signup, or
// a returning Google user). Auto-expires a stale 'pending' row it finds.
async function findActiveInviteForEmail(email) {
  const invite = await prisma.invite.findFirst({
    where: { email, status: { in: ['pending', 'accepted'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!invite) return null;

  if (invite.status === 'pending' && invite.expiresAt < new Date()) {
    await prisma.invite.update({ where: { id: invite.id }, data: { status: 'expired' } });
    return null;
  }

  return invite;
}

module.exports = { createInvites, validateToken, findActiveInviteForEmail, HttpError };
