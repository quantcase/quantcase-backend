'use strict';

/**
 * Role guard middleware factory for WealthOS routes.
 * Accepts one or more role strings (e.g. 'cio', 'super_admin') or an array of roles.
 * Must be mounted AFTER wealthOrgContext.
 */
function requireWealthRole(...allowedRoles) {
  const roles = allowedRoles.flat();

  return (req, res, next) => {
    if (!req.wealthRole) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: No organization role determined',
      });
    }

    if (!roles.includes(req.wealthRole)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: Insufficient permissions. Required role(s): ${roles.join(', ')}`,
      });
    }

    next();
  };
}

module.exports = requireWealthRole;
