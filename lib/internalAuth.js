'use strict';

const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/auth');

// Server-to-server dispatch (the scheduler's pipeline handlers and the admin
// L1/L2/L3 multi-dispatch services) triggers work by POSTing to this same API
// over HTTP. `middleware/globalAuth.js` requires a Bearer JWT on every
// non-allowlisted route, so those self-calls must carry one too — without it
// they get 401 "No token provided" and nothing reaches BullMQ.
//
// Signed with the same secret as user tokens and shaped like `issueTokens`
// (controllers/auth.controller.js) so `authenticate` + `requireAdmin` both
// accept it. Short-lived and minted per request: a long dispatch run can span
// hours, and a cached token would expire mid-run.
const INTERNAL_TOKEN_TTL = '10m';

function internalServiceToken() {
  return jwt.sign(
    {
      sub:         'internal:pipeline-dispatch',
      email:       'internal@quantcase.local',
      accountType: 'admin',
      internal:    true,
    },
    jwtSecret,
    { expiresIn: INTERNAL_TOKEN_TTL },
  );
}

function internalAuthHeaders() {
  return { Authorization: `Bearer ${internalServiceToken()}` };
}

module.exports = { internalServiceToken, internalAuthHeaders };
