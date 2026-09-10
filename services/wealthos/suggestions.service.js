'use strict';

const prisma    = require('../../config/prisma');
const jobQueue  = require('../../lib/jobQueue');
const { computePriorityScore } = require('./scoring.service');
const { writeAuditLog, getClientById } = require('./clients.service');

const MAX_CLIENTS_PER_JOB = 20;

async function listSuggestionsForClient(orgId, clientId, filters = {}) {
  await getClientById(orgId, clientId);

  const where = { client_id: clientId, client: { org_id: orgId } };
  if (filters.status)   where.status   = filters.status;
  if (filters.priority) where.priority = filters.priority;

  return prisma.wealthSuggestion.findMany({
    where,
    orderBy: [{ score: 'desc' }, { created_at: 'desc' }],
  });
}

async function enqueueSuggestionGeneration(orgId, clientIds, rmProfileId) {
  let clients;
  if (clientIds && clientIds.length > 0) {
    clients = await prisma.wealthClient.findMany({
      where:   { id: { in: clientIds }, org_id: orgId },
      include: {
        portfolio: {
          include: { holdings: true },
        },
      },
    });
  } else {
    clients = await prisma.wealthClient.findMany({
      where:   { rm_profile_id: rmProfileId, org_id: orgId },
      include: {
        portfolio: {
          include: { holdings: true },
        },
      },
    });
  }

  if (clients.length === 0) {
    const err = new Error('No clients found for the given criteria');
    err.status = 404;
    throw err;
  }

  // Score each client and build job payload entries
  const clientPayloads = clients.map((client) => {
    const { score, components, priority } = computePriorityScore(client, client.portfolio);
    return {
      clientId:      client.id,
      clientData:    {
        id:                client.id,
        name:              client.name,
        segment:           client.segment,
        risk_profile:      client.risk_profile,
        engagement_score:  client.engagement_score,
        churn_probability: client.churn_probability,
        last_contact_at:   client.last_contact_at,
      },
      portfolioData: client.portfolio
        ? {
            id:                  client.portfolio.id,
            total_value_cr:      client.portfolio.total_value_cr,
            risk_score:          client.portfolio.risk_score,
            last_rebalance_date: client.portfolio.last_rebalance_date,
            holdings:            client.portfolio.holdings || [],
          }
        : null,
      score,
      components,
      priority,
    };
  });

  // Split into chunks of MAX_CLIENTS_PER_JOB and enqueue each batch
  const jobs = [];
  for (let i = 0; i < clientPayloads.length; i += MAX_CLIENTS_PER_JOB) {
    const batch = clientPayloads.slice(i, i + MAX_CLIENTS_PER_JOB);
    const job   = await jobQueue.addJob('wealthos_suggestion', {
      type:    'wealthos_suggestion',
      orgId,
      clients: batch,
      rmId:    rmProfileId ?? null,
    });
    jobs.push({ id: job.id, status: 'pending', clientCount: batch.length });
  }

  return jobs;
}

async function updateSuggestionStatus(orgId, suggestionId, status, rmProfileId) {
  const suggestion = await prisma.wealthSuggestion.findFirst({
    where: {
      id:     suggestionId,
      client: { org_id: orgId },
    },
  });

  if (!suggestion) {
    const err = new Error('Suggestion not found');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.wealthSuggestion.update({
    where: { id: suggestionId },
    data:  { status, updated_at: new Date() },
  });

  await writeAuditLog(orgId, 'suggestion', suggestionId, status, rmProfileId, { status });

  // If acted upon, record action
  if (status === 'used') {
    await prisma.wealthAction.create({
      data: {
        suggestion_id: suggestionId,
        client_id:     suggestion.client_id,
        rm_id:         rmProfileId ?? null,
        action_type:   'used_suggestion',
        content:       suggestion.message ?? null,
      },
    });
  }

  return updated;
}

module.exports = {
  listSuggestionsForClient,
  enqueueSuggestionGeneration,
  updateSuggestionStatus,
};
