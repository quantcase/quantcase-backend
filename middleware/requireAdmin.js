'use strict';

// Must run after `authenticate` (needs req.user). Restricts /admin/* to
// super-admins (account_type='admin', the JWT's `accountType` claim).
// Wealth managers (account_type='manager') are elevated for access/billing
// purposes but are NOT super-admins and cannot reach these routes.
const requireAdmin = (req, res, next) => {
  if (req.user?.accountType !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = requireAdmin;
