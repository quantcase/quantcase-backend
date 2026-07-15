'use strict';

// Must run after `authenticate` (needs req.user). Restricts /admin/* to
// accounts with account_type='manager' (the JWT's `accountType` claim).
const requireAdmin = (req, res, next) => {
  if (req.user?.accountType !== 'manager') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = requireAdmin;
