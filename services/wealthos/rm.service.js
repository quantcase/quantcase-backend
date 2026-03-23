'use strict';

const prisma = require('../../config/prisma');

async function listRmUsers() {
  return prisma.wealthRmUser.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { clients: true } },
    },
  });
}

async function getRmById(rmId) {
  const rm = await prisma.wealthRmUser.findUnique({
    where:   { id: rmId },
    include: {
      clients: {
        select: {
          id:               true,
          name:             true,
          segment:          true,
          risk_profile:     true,
          churn_probability:true,
          last_contact_at:  true,
        },
      },
      _count: { select: { clients: true, interactions: true } },
    },
  });
  if (!rm) {
    const err = new Error('RM user not found');
    err.status = 404;
    throw err;
  }
  return rm;
}

async function createRmUser(data) {
  return prisma.wealthRmUser.create({ data });
}

module.exports = { listRmUsers, getRmById, createRmUser };
