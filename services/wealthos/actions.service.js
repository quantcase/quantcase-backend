'use strict';

const prisma = require('../../config/prisma');
const { getClientById, writeAuditLog } = require('./clients.service');

async function logAction(data) {
  await getClientById(data.client_id); // throws 404 if client not found
  const action = await prisma.wealthAction.create({ data });
  await writeAuditLog('action', action.id, 'logged', data.rm_id, data);
  return action;
}

async function listClientActions(clientId, page = 1, size = 20) {
  await getClientById(clientId);
  const [total, actions] = await Promise.all([
    prisma.wealthAction.count({ where: { client_id: clientId } }),
    prisma.wealthAction.findMany({
      where:   { client_id: clientId },
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { created_at: 'desc' },
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
