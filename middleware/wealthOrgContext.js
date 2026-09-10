'use strict';

const prisma = require('../config/prisma');

/**
 * Middleware that resolves the active WealthOS organisation membership for the authenticated user.
 * Attaches:
 *  - req.wealthOrg: WealthOrganisation
 *  - req.wealthMember: WealthOrgMember
 *  - req.wealthRole: 'super_admin' | 'cio' | 'rm'
 *  - req.wealthRmProfile: WealthRmProfile | null
 */
async function wealthOrgContext(req, res, next) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required',
      });
    }

    const member = await prisma.wealthOrgMember.findFirst({
      where: {
        user_id: userId,
        is_active: true,
      },
      include: {
        org: true,
        rm_profile: true,
      },
    });

    if (!member || !member.org || !member.org.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: No active WealthOS organization membership found for this user',
      });
    }

    req.wealthOrg = member.org;
    req.wealthMember = member;
    req.wealthRole = member.role;
    req.wealthRmProfile = member.rm_profile || null;

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = wealthOrgContext;
