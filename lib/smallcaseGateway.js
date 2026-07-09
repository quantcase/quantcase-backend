'use strict';

/**
 * Smallcase Gateway server-to-server client.
 *
 * Two credentials, two distinct roles:
 *   - SMALLCASE_SECRET     (shared secret) — signs the HS256 JWT sent as `x-gateway-authtoken`.
 *   - SMALLCASE_API_SECRET (API secret)    — sent verbatim as `x-gateway-secret`, and is the
 *                                            HMAC key used to verify webhook checksums.
 *
 * Every request carries both headers. Follows the lazy-guard client pattern used by
 * `getRazorpay()` in services/billing.service.js.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');

function assertConfigured() {
  if (!env.smallcaseSecret || !env.smallcaseApiSecret) {
    const err = new Error('Smallcase Gateway credentials not configured');
    err.status = 500;
    throw err;
  }
}

/**
 * Sign the JWT that authenticates the user to the Gateway.
 * The Gateway requires the payload to identify the user:
 *   - New/guest user (connect/holdings-import): { guest: true }
 *   - Connected user (holdings fetch, orders):   { smallcaseAuthId: <id> }
 */
function signAuthToken({ smallcaseAuthId } = {}) {
  assertConfigured();
  const payload = smallcaseAuthId
    ? { smallcaseAuthId }
    : { guest: true };
  return jwt.sign(payload, env.smallcaseSecret, { algorithm: 'HS256' });
}

async function request(method, path, { body, smallcaseAuthId } = {}) {
  assertConfigured();
  const url = `${env.smallcaseApiBaseUrl}${path}`;
  const headers = {
    'Content-Type':       'application/json',
    'x-gateway-secret':   env.smallcaseApiSecret,
    'x-gateway-authtoken': signAuthToken({ smallcaseAuthId }),
  };

  // ─── DEBUG: log the exact outgoing request to smallcase ───────────────────
  console.log('[smallcase →] request', JSON.stringify({
    method,
    url,
    headers: {
      ...headers,
      // Mask secrets so they don't leak into logs; show length to confirm they're set.
      'x-gateway-secret':    `<${headers['x-gateway-secret']?.length || 0} chars>`,
      'x-gateway-authtoken': headers['x-gateway-authtoken'],
    },
    body: body || null,
  }, null, 2));

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawBody = await res.text();
  let json = null;
  try { json = rawBody ? JSON.parse(rawBody) : null; } catch { /* non-JSON error body */ }

  // ─── DEBUG: log the exact response from smallcase ─────────────────────────
  console.log('[smallcase ←] response', JSON.stringify({
    status:  res.status,
    ok:      res.ok,
    headers: Object.fromEntries(res.headers.entries()),
    body:    json ?? rawBody,
  }, null, 2));

  if (!res.ok || (json && json.success === false)) {
    const msg = (json && (json.message || json.errors)) || `Smallcase Gateway request failed (${res.status})`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    err.smallcase = json;
    throw err;
  }
  return json;
}

/**
 * Create a Gateway transaction. Returns { transactionId, expireAt } for the frontend SDK.
 * intent: 'HOLDINGS_IMPORT' | 'TRANSACTION' | 'CONNECT' | ...
 * config is merged into the request body (e.g. { assetConfig } or { orderConfig }).
 */
async function createTransaction(intent, config = {}, smallcaseAuthId) {
  const path = `/gateway/${env.smallcaseGatewayName}/transaction`;
  const json = await request('POST', path, {
    body: { intent, ...config },
    smallcaseAuthId,
  });
  return json.data || json;
}

/** Fetch a transaction's result by id (status, authToken, broker, holdings, smallcaseAuthId). */
async function fetchTransactionDetails(transactionId, smallcaseAuthId) {
  const path = `/v1/${env.smallcaseGatewayName}/engine/transactiondetails?transactionId=${encodeURIComponent(transactionId)}`;
  const json = await request('GET', path, { smallcaseAuthId });
  return json.data || json;
}

/** Fetch a connected user's holdings (v2 securities format). */
async function fetchHoldings(smallcaseAuthId) {
  const path = `/v1/${env.smallcaseGatewayName}/engine/user/holdings?version=v2`;
  const json = await request('GET', path, { smallcaseAuthId });
  return json.data || json;
}

/**
 * Verify a webhook checksum.
 *   securities / holdings-import: SHA256-HMAC(timestamp + smallcaseAuthId, API_SECRET)
 *   mf holdings import:           SHA256-HMAC(timestamp + transactionId,   API_SECRET)
 */
function verifyWebhookChecksum({ timestamp, smallcaseAuthId, transactionId }, checksum, { mf = false } = {}) {
  assertConfigured();
  if (!checksum) return false;
  const message = `${timestamp}${mf ? transactionId : smallcaseAuthId}`;
  const expected = crypto
    .createHmac('sha256', env.smallcaseApiSecret)
    .update(message)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(checksum));
  } catch {
    return false;
  }
}

module.exports = {
  signAuthToken,
  createTransaction,
  fetchTransactionDetails,
  fetchHoldings,
  verifyWebhookChecksum,
};
