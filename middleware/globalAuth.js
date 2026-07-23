'use strict';

const authenticate = require('./authenticate');
const { isPublicRequest } = require('./publicRoutes');

// Global gate mounted before the main router (server.js): allowlisted public
// paths pass straight through; everything else must present a valid Bearer JWT.
// Reuses `authenticate` verbatim, so it sets `req.user` and returns the same
// 401s. `/admin/*` still layers `requireAdmin` on top at its own mount.
module.exports = (req, res, next) => {
  if (isPublicRequest(req)) return next();
  return authenticate(req, res, next);
};
