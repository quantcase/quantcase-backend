'use strict';

const prisma = require('../../config/prisma');
const { getClientById, writeAuditLog } = require('./clients.service');

async function logAction(orgId, data, rmProfileId = null) {
  await getClientById(orgId, data.client_id);

  const actionPayload = {
    ...data,
    rm_id: rmProfileId || data.rm_id || null,
  };

  const action = await prisma.wealthAction.create({ data: actionPayload });
  await writeAuditLog(orgId, 'action', action.id, 'logged', actionPayload.rm_id, actionPayload);
  return action;
}

async function listClientActions(orgId, clientId, page = 1, size = 20) {
  await getClientById(orgId, clientId);

  const [total, actions] = await Promise.all([
    prisma.wealthAction.count({
      where: {
        client_id: clientId,
        client:    { org_id: orgId },
      },
    }),
    prisma.wealthAction.findMany({
      where: {
        client_id: clientId,
        client:    { org_id: orgId },
      },
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { created_at: 'desc' },
      include: {
        rm: {
          select: {
            id:           true,
            display_name: true,
          },
        },
      },
    }),
  ]);

  return {
    data: actions,
    pagination: {
      page,
      size,
      totalItems:      total,
      totalPages:      Math.ceil(total / size),
      hasNextPage:     page * size < total,
      hasPreviousPage: page > 1,
    },
  };
}

module.exports = { logAction, listClientActions };
