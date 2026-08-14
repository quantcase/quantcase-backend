'use strict';

// Single source of truth for endpoints reachable WITHOUT a user JWT.
// `middleware/globalAuth.js` gates every other request through `authenticate`.
// Paths are matched against `req.path` (query string excluded) at the app level,
// exactly like the WEBHOOK_PATHS check that used to live inline in server.js.

// Exact method+path matches.
const PUBLIC_EXACT = [
  { method: 'GET',  path: '/health' },
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/google' },
  { method: 'POST', path: '/api/auth/signin' },
  { method: 'POST', path: '/api/request-access' },
  { method: 'GET',  path: '/api/invites/validate' },  // frontend hits this before signup (no token yet)
  { method: 'GET',  path: '/api/billing/config' },     // pricing page reads — kept public
  { method: 'GET',  path: '/api/billing/products' },
  { method: 'POST', path: '/api/billing/webhook' },    // Razorpay HMAC checksum, not JWT
  { method: 'POST', path: '/api/smallcase/webhook' },  // smallcase checksum, not JWT
];

// Path prefixes that must stay reachable (any method).
const PUBLIC_PREFIX = ['/uploads'];  // worker.js fetches admin-uploaded PDFs server-to-server

// Webhook paths skip the global JSON parser so their raw body survives for
// signature/checksum verification. Reused by server.js.
const WEBHOOK_PATHS = ['/api/billing/webhook', '/api/smallcase/webhook'];

function isPublicRequest(req) {
  if (req.method === 'OPTIONS') return true;  // CORS preflight — app.use(cors()) doesn't auto-terminate it
  if (PUBLIC_PREFIX.some((p) => req.path === p || req.path.startsWith(p + '/'))) return true;
  return PUBLIC_EXACT.some((r) => r.method === req.method && r.path === req.path);
}

module.exports = { isPublicRequest, PUBLIC_EXACT, PUBLIC_PREFIX, WEBHOOK_PATHS };
