'use strict';

const prisma    = require('../../config/prisma');
const jobQueue  = require('../../lib/jobQueue');

// ─── Audit helper ─────────────────────────────────────────────────────────────

async function writeAuditLog(entityType, entityId, action, performedBy, payload) {
  await prisma.wealthAuditLog.create({
    data: {
      entity_type:  entityType,
      entity_id:    entityId,
      action,
      performed_by: performedBy ?? null,
      payload:      payload ?? null,
    },
  });
}

// ─── Clients ──────────────────────────────────────────────────────────────────

async function listClients(page = 1, size = 20, filters = {}) {
  const where = {};
  if (filters.segment) where.segment  = filters.segment;
  if (filters.rm_id)   where.rm_id    = filters.rm_id;
  if (filters.search) {
    where.OR = [
      { name:  { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.wealthClient.count({ where }),
    prisma.wealthClient.findMany({
      where,
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { created_at: 'desc' },
      include: { rm: { select: { id: true, name: true } } },
    }),
  ]);

  return {
    data,
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

async function createClient(data) {
  const client = await prisma.wealthClient.create({ data });
  await writeAuditLog('client', client.id, 'created', data.rm_id, data);
  return client;
}

async function getClientById(clientId) {
  const client = await prisma.wealthClient.findUnique({
    where:   { id: clientId },
    include: {
      portfolio: true,
      rm:        { select: { id: true, name: true, team: true } },
    },
  });
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  return client;
}

async function updateClient(clientId, data) {
  await getClientById(clientId); // throws 404 if not found
  const updated = await prisma.wealthClient.update({
    where: { id: clientId },
    data,
  });
  await writeAuditLog('client', clientId, 'updated', data.rm_id, data);
  return updated;
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

async function getClientPortfolio(clientId) {
  await getClientById(clientId); // throws 404 if client not found
  const portfolio = await prisma.wealthPortfolio.findUnique({
    where: { client_id: clientId },
  });
  if (!portfolio) {
    const err = new Error('Portfolio not found for this client');
    err.status = 404;
    throw err;
  }
  return portfolio;
}

async function upsertClientPortfolio(clientId, data) {
  await getClientById(clientId); // throws 404 if client not found
  const portfolio = await prisma.wealthPortfolio.upsert({
    where:  { client_id: clientId },
    update: { ...data, updated_at: new Date() },
    create: { client_id: clientId, ...data },
  });
  await writeAuditLog('portfolio', portfolio.id, 'upserted', null, { clientId, ...data });
  return portfolio;
}

// ─── Interactions ─────────────────────────────────────────────────────────────

async function listClientInteractions(clientId, page = 1, size = 20) {
  await getClientById(clientId);
  const [total, data] = await Promise.all([
    prisma.wealthInteraction.count({ where: { client_id: clientId } }),
    prisma.wealthInteraction.findMany({
      where:   { client_id: clientId },
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { timestamp: 'desc' },
    }),
  ]);
  return {
    data,
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

async function createInteraction(clientId, data) {
  await getClientById(clientId);
  const interaction = await prisma.wealthInteraction.create({
    data: { client_id: clientId, ...data },
  });
  // Update last_contact_at and bump engagement_score
  await prisma.wealthClient.update({
    where: { id: clientId },
    data:  {
      last_contact_at:  new Date(),
      engagement_score: { increment: 1 },
    },
  });
  return interaction;
}

// ─── Approved Model assignments ───────────────────────────────────────────────

async function assignModelToClient(clientId, modelId) {
  await getClientById(clientId);
  const model = await prisma.wealthApprovedModel.findUnique({ where: { id: modelId } });
  if (!model) {
    const err = new Error('Approved model not found');
    err.status = 404;
    throw err;
  }
  try {
    const mapping = await prisma.wealthClientModelMapping.create({
      data: { client_id: clientId, model_id: modelId },
    });
    await writeAuditLog('client_model_mapping', mapping.id, 'assigned', null, { clientId, modelId });
    return mapping;
  } catch (e) {
    if (e.code === 'P2002') { // unique constraint violation
      const err = new Error('Model already assigned to this client');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

async function removeModelFromClient(clientId, modelId) {
  const mapping = await prisma.wealthClientModelMapping.findUnique({
    where: { client_id_model_id: { client_id: clientId, model_id: modelId } },
  });
  if (!mapping) {
    const err = new Error('Model assignment not found');
    err.status = 404;
    throw err;
  }
  await prisma.wealthClientModelMapping.delete({
    where: { client_id_model_id: { client_id: clientId, model_id: modelId } },
  });
  await writeAuditLog('client_model_mapping', mapping.id, 'removed', null, { clientId, modelId });
}

// ─── Message generation (async job) ──────────────────────────────────────────

async function enqueueMessageGeneration(clientId, channel, context, rmId) {
  const client    = await getClientById(clientId);
  const portfolio = await prisma.wealthPortfolio.findUnique({ where: { client_id: clientId } });
  const interactions = await prisma.wealthInteraction.findMany({
    where:   { client_id: clientId },
    orderBy: { timestamp: 'desc' },
    take:    3,
  });

  const job = await jobQueue.addJob('wealthos_message', {
    type:         'wealthos_message',
    clientId,
    client,
    portfolio,
    interactions,
    channel,
    context:      context ?? null,
    rmId:         rmId ?? null,
  });

  return { id: job.id, status: 'pending' };
}

module.exports = {
  listClients,
  createClient,
  getClientById,
  updateClient,
  getClientPortfolio,
  upsertClientPortfolio,
  listClientInteractions,
  createInteraction,
  assignModelToClient,
  removeModelFromClient,
  enqueueMessageGeneration,
  writeAuditLog,
};
