'use strict';

const prisma   = require('../../config/prisma');
const jobQueue = require('../../lib/jobQueue');

// ─── Audit helper ─────────────────────────────────────────────────────────────

async function writeAuditLog(orgId, entityType, entityId, action, performedBy, payload) {
  try {
    await prisma.wealthAuditLog.create({
      data: {
        org_id:       orgId,
        entity_type:  entityType,
        entity_id:    entityId,
        action,
        performed_by: performedBy ?? null,
        payload:      payload ?? null,
      },
    });
  } catch (err) {
    console.error('[writeAuditLog error]', err.message);
  }
}

// ─── Clients ──────────────────────────────────────────────────────────────────

async function listClients(orgId, page = 1, size = 20, filters = {}, wealthRole = null, rmProfileId = null) {
  const where = { org_id: orgId };

  // Role scoping: RMs can only see their own assigned clients
  if (wealthRole === 'rm' && rmProfileId) {
    where.rm_profile_id = rmProfileId;
  } else if (filters.rm_profile_id) {
    where.rm_profile_id = filters.rm_profile_id;
  }

  if (filters.segment) {
    where.segment = filters.segment;
  }
  if (filters.lifecycle_status) {
    where.lifecycle_status = filters.lifecycle_status;
  }
  if (filters.kyc_status) {
    where.kyc_status = filters.kyc_status;
  }
  if (filters.risk_profile) {
    where.risk_profile = filters.risk_profile;
  }

  if (filters.search) {
    where.OR = [
      { name:  { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
      { phone: { contains: filters.search, mode: 'insensitive' } },
      { city:  { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.wealthClient.count({ where }),
    prisma.wealthClient.findMany({
      where,
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { created_at: 'desc' },
      include: {
        rm: {
          select: {
            id:           true,
            display_name: true,
            team:         true,
          },
        },
        portfolio: {
          select: {
            total_value_cr:      true,
            risk_score:          true,
            last_rebalance_date: true,
          },
        },
      },
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

async function createClient(orgId, data, wealthRole = null, rmProfileId = null) {
  const clientData = {
    ...data,
    org_id: orgId,
  };

  // If created by an RM, ensure it is assigned to their own RM profile
  if (wealthRole === 'rm' && rmProfileId) {
    clientData.rm_profile_id = rmProfileId;
  }

  const client = await prisma.wealthClient.create({ data: clientData });
  await writeAuditLog(orgId, 'client', client.id, 'created', rmProfileId, clientData);
  return client;
}

async function getClientById(orgId, clientId, wealthRole = null, rmProfileId = null) {
  const client = await prisma.wealthClient.findFirst({
    where: {
      id:     clientId,
      org_id: orgId,
    },
    include: {
      portfolio: {
        include: {
          holdings: {
            include: {
              alerts: {
                where: { is_resolved: false },
              },
            },
          },
        },
      },
      rm: {
        select: {
          id:           true,
          display_name: true,
          team:         true,
          email:        true,
          phone:        true,
        },
      },
      model_mappings: {
        include: {
          model: true,
        },
      },
    },
  });

  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }

  // RM ownership verification
  if (wealthRole === 'rm' && rmProfileId && client.rm_profile_id !== rmProfileId) {
    const err = new Error('Access denied to this client record');
    err.status = 403;
    throw err;
  }

  return client;
}

async function updateClient(orgId, clientId, data, wealthRole = null, rmProfileId = null) {
  await getClientById(orgId, clientId, wealthRole, rmProfileId); // checks exists & permission

  // Clean data so org_id cannot be overwritten
  const updateData = { ...data };
  delete updateData.id;
  delete updateData.org_id;

  // RM cannot reassign client to another RM
  if (wealthRole === 'rm') {
    delete updateData.rm_profile_id;
  }

  const updated = await prisma.wealthClient.update({
    where: { id: clientId },
    data:  updateData,
  });

  await writeAuditLog(orgId, 'client', clientId, 'updated', rmProfileId, updateData);
  return updated;
}

// ─── Portfolio & Holdings ─────────────────────────────────────────────────────

async function getClientPortfolio(orgId, clientId, wealthRole = null, rmProfileId = null) {
  await getClientById(orgId, clientId, wealthRole, rmProfileId);

  const portfolio = await prisma.wealthPortfolio.findUnique({
    where:   { client_id: clientId },
    include: {
      holdings: {
        include: {
          alerts: true,
        },
      },
    },
  });

  if (!portfolio) {
    const err = new Error('Portfolio not found for this client');
    err.status = 404;
    throw err;
  }
  return portfolio;
}

async function upsertClientPortfolio(orgId, clientId, data, wealthRole = null, rmProfileId = null) {
  const client = await getClientById(orgId, clientId, wealthRole, rmProfileId);

  const {
    holdings,
    total_value_cr,
    equity_value_cr,
    debt_value_cr,
    mf_value_cr,
    reit_value_cr,
    alt_value_cr,
    cash_value_cr,
    risk_score,
    last_rebalance_date,
  } = data;

  // Compute total if not explicitly provided and holdings are present
  let resolvedTotalValue = total_value_cr;
  if (resolvedTotalValue === undefined && Array.isArray(holdings)) {
    resolvedTotalValue = holdings.reduce((sum, h) => sum + (Number(h.current_value_cr) || 0), 0);
  }

  const portfolioPayload = {
    total_value_cr:      resolvedTotalValue !== undefined ? Number(resolvedTotalValue) : 0,
    equity_value_cr:     equity_value_cr !== undefined ? Number(equity_value_cr) : null,
    debt_value_cr:       debt_value_cr !== undefined ? Number(debt_value_cr) : null,
    mf_value_cr:         mf_value_cr !== undefined ? Number(mf_value_cr) : null,
    reit_value_cr:       reit_value_cr !== undefined ? Number(reit_value_cr) : null,
    alt_value_cr:        alt_value_cr !== undefined ? Number(alt_value_cr) : null,
    cash_value_cr:       cash_value_cr !== undefined ? Number(cash_value_cr) : null,
    risk_score:          risk_score !== undefined ? Number(risk_score) : null,
    last_rebalance_date: last_rebalance_date ? new Date(last_rebalance_date) : null,
    updated_at:          new Date(),
  };

  const result = await prisma.$transaction(async (tx) => {
    // 1. Upsert WealthPortfolio
    const portfolio = await tx.wealthPortfolio.upsert({
      where:  { client_id: clientId },
      update: portfolioPayload,
      create: { client_id: clientId, ...portfolioPayload },
    });

    // 2. Manage relational holdings if supplied
    if (Array.isArray(holdings)) {
      // Delete existing holdings for this portfolio
      await tx.wealthHolding.deleteMany({
        where: { portfolio_id: portfolio.id },
      });

      if (holdings.length > 0) {
        const holdingsCreateData = holdings.map((h) => ({
          portfolio_id:     portfolio.id,
          ticker:           h.ticker || null,
          isin:             h.isin || null,
          scheme_name:      h.scheme_name || null,
          amfi_code:        h.amfi_code || null,
          asset_class:      h.asset_class,
          quantity:         h.quantity !== undefined ? Number(h.quantity) : null,
          avg_price:        h.avg_price !== undefined ? Number(h.avg_price) : null,
          current_value_cr: h.current_value_cr !== undefined ? Number(h.current_value_cr) : null,
          weight_pct:       h.weight_pct !== undefined ? Number(h.weight_pct) : null,
          as_of_date:       h.as_of_date ? new Date(h.as_of_date) : new Date(),
        }));

        await tx.wealthHolding.createMany({
          data: holdingsCreateData,
        });
      }
    }

    // 3. Denormalized AUM sync: update WealthClient.aum_cr
    await tx.wealthClient.update({
      where: { id: clientId },
      data:  { aum_cr: portfolioPayload.total_value_cr },
    });

    // 4. Denormalized AUM sync: update WealthRmProfile.total_aum_cr if RM assigned
    if (client.rm_profile_id) {
      const rmClientsAum = await tx.wealthClient.aggregate({
        where: { rm_profile_id: client.rm_profile_id, org_id: orgId },
        _sum:  { aum_cr: true },
      });
      const newRmAum = rmClientsAum._sum.aum_cr || 0;
      await tx.wealthRmProfile.update({
        where: { id: client.rm_profile_id },
        data:  { total_aum_cr: newRmAum },
      });
    }

    return tx.wealthPortfolio.findUnique({
      where:   { id: portfolio.id },
      include: {
        holdings: {
          include: { alerts: true },
        },
      },
    });
  });

  await writeAuditLog(orgId, 'portfolio', result.id, 'upserted', rmProfileId, {
    clientId,
    total_value_cr: portfolioPayload.total_value_cr,
    holdingsCount:  holdings?.length ?? 0,
  });

  return result;
}

// ─── Interactions ─────────────────────────────────────────────────────────────

async function listClientInteractions(orgId, clientId, page = 1, size = 20, wealthRole = null, rmProfileId = null) {
  await getClientById(orgId, clientId, wealthRole, rmProfileId);

  const [total, data] = await Promise.all([
    prisma.wealthInteraction.count({ where: { client_id: clientId, org_id: orgId } }),
    prisma.wealthInteraction.findMany({
      where:   { client_id: clientId, org_id: orgId },
      skip:    (page - 1) * size,
      take:    size,
      orderBy: { timestamp: 'desc' },
      include: {
        rm: {
          select: {
            id:           true,
            display_name: true,
          },
        },
        attachments: true,
      },
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

async function createInteraction(orgId, clientId, data, rmProfileId = null) {
  const client = await getClientById(orgId, clientId);

  const interactionPayload = {
    ...data,
    org_id:        orgId,
    client_id:     clientId,
    rm_profile_id: rmProfileId || client.rm_profile_id,
    timestamp:     data.timestamp ? new Date(data.timestamp) : new Date(),
    follow_up_date: data.follow_up_date ? new Date(data.follow_up_date) : null,
  };

  const interaction = await prisma.wealthInteraction.create({
    data: interactionPayload,
  });

  // Update client last_contact_at and increment engagement_score
  await prisma.wealthClient.update({
    where: { id: clientId },
    data:  {
      last_contact_at:  new Date(),
      engagement_score: { increment: 1 },
    },
  });

  await writeAuditLog(orgId, 'interaction', interaction.id, 'created', rmProfileId, interactionPayload);
  return interaction;
}

// ─── Approved Model assignments ───────────────────────────────────────────────

async function assignModelToClient(orgId, clientId, modelId, performedBy = null) {
  await getClientById(orgId, clientId);
  const model = await prisma.wealthApprovedModel.findFirst({
    where: { id: modelId, org_id: orgId },
  });

  if (!model) {
    const err = new Error('Approved model not found');
    err.status = 404;
    throw err;
  }

  try {
    const mapping = await prisma.wealthClientModelMapping.create({
      data: { client_id: clientId, model_id: modelId },
    });
    await writeAuditLog(orgId, 'client_model_mapping', mapping.id, 'assigned', performedBy, { clientId, modelId });
    return mapping;
  } catch (e) {
    if (e.code === 'P2002') {
      const err = new Error('Model already assigned to this client');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

async function removeModelFromClient(orgId, clientId, modelId, performedBy = null) {
  await getClientById(orgId, clientId);
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

  await writeAuditLog(orgId, 'client_model_mapping', mapping.id, 'removed', performedBy, { clientId, modelId });
}

// ─── Message generation (async job) ──────────────────────────────────────────

async function enqueueMessageGeneration(orgId, clientId, channel, context, rmProfileId) {
  const client = await getClientById(orgId, clientId);
  const portfolio = await prisma.wealthPortfolio.findUnique({
    where:   { client_id: clientId },
    include: { holdings: true },
  });
  const interactions = await prisma.wealthInteraction.findMany({
    where:   { client_id: clientId, org_id: orgId },
    orderBy: { timestamp: 'desc' },
    take:    3,
  });

  const job = await jobQueue.addJob('wealthos_message', {
    type:         'wealthos_message',
    orgId,
    clientId,
    client,
    portfolio,
    interactions,
    channel,
    context:      context ?? null,
    rmId:         rmProfileId ?? null,
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
