'use strict';

const { adminEmail } = require('../config/env');

// Must run after `authenticate` (needs req.user). Restricts access to the
// single admin account — see CLAUDE.md "Admin API access is restricted".
const requireAdmin = (req, res, next) => {
  if (!req.user?.email || req.user.email.toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = requireAdmin;
