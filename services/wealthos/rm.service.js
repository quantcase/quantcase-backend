'use strict';

const bcrypt = require('bcryptjs');
const prisma = require('../../config/prisma');

async function listRmProfiles(orgId) {
  return prisma.wealthRmProfile.findMany({
    where:   { org_id: orgId },
    orderBy: { display_name: 'asc' },
    include: {
      member: {
        select: {
          id:        true,
          user_id:   true,
          role:      true,
          is_active: true,
          user: {
            select: {
              email:        true,
              display_name: true,
              mobile:       true,
            },
          },
        },
      },
      _count: {
        select: {
          clients:       true,
          interactions:  true,
          tasks:         true,
          opportunities: true,
        },
      },
    },
  });
}

async function getRmProfileById(orgId, rmProfileId) {
  const rm = await prisma.wealthRmProfile.findFirst({
    where: {
      id:     rmProfileId,
      org_id: orgId,
    },
    include: {
      member: {
        select: {
          id:        true,
          user_id:   true,
          role:      true,
          is_active: true,
          user: {
            select: {
              email:        true,
              display_name: true,
            },
          },
        },
      },
      clients: {
        take:    100,
        orderBy: { aum_cr: 'desc' },
        select: {
          id:                true,
          name:              true,
          email:             true,
          phone:             true,
          city:              true,
          aum_cr:            true,
          segment:           true,
          risk_profile:      true,
          lifecycle_status:  true,
          churn_probability: true,
          last_contact_at:   true,
        },
      },
      _count: {
        select: {
          clients:       true,
          interactions:  true,
          tasks:         true,
          opportunities: true,
        },
      },
    },
  });

  if (!rm) {
    const err = new Error('RM profile not found');
    err.status = 404;
    throw err;
  }

  return rm;
}

async function createRmProfile(orgId, data) {
  const {
    email,
    display_name,
    phone,
    team,
    target_aum_cr,
    notes,
    password,
  } = data;

  const resolvedPassword = password || 'Quantcase@123';
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(resolvedPassword, salt);

  return prisma.$transaction(async (tx) => {
    // 1. Find or create base User
    let user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      user = await tx.user.create({
        data: {
          email,
          display_name,
          mobile: phone || null,
          account_type: 'manager',
          password_hash: passwordHash,
        },
      });
      await tx.userProfile.create({
        data: {
          user_id: user.id,
          full_name: display_name,
          phone: phone || null,
        },
      });
    }

    // 2. Check if already a member of this organisation
    const existingMember = await tx.wealthOrgMember.findUnique({
      where: {
        org_id_user_id: {
          org_id: orgId,
          user_id: user.id,
        },
      },
    });

    if (existingMember) {
      const err = new Error('User is already a member of this organisation');
      err.status = 409;
      throw err;
    }

    // 3. Create WealthOrgMember
    const member = await tx.wealthOrgMember.create({
      data: {
        org_id:  orgId,
        user_id: user.id,
        role:    'rm',
      },
    });

    // 4. Create WealthRmProfile
    const profile = await tx.wealthRmProfile.create({
      data: {
        org_id:        orgId,
        member_id:     member.id,
        display_name:  display_name || user.display_name,
        email:         email,
        phone:         phone || user.mobile,
        team:          team || null,
        target_aum_cr: target_aum_cr !== undefined ? Number(target_aum_cr) : null,
        notes:         notes || null,
      },
      include: {
        member: {
          include: {
            user: {
              select: {
                id:           true,
                email:        true,
                display_name: true,
              },
            },
          },
        },
      },
    });

    return profile;
  });
}

module.exports = {
  listRmProfiles,
  getRmProfileById,
  createRmProfile,
  // Backwards compatibility aliases
  listRmUsers:  listRmProfiles,
  getRmById:    getRmProfileById,
  createRmUser: createRmProfile,
};
