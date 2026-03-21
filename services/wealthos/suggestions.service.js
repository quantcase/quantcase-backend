'use strict';

const prisma    = require('../../config/prisma');
const jobQueue  = require('../../lib/jobQueue');
const { computePriorityScore } = require('./scoring.service');
const { writeAuditLog }        = require('./clients.service');

const MAX_CLIENTS_PER_JOB = 20;

async function listSuggestionsForClient(clientId, filters = {}) {
  const where = { client_id: clientId };
  if (filters.status)   where.status   = filters.status;
  if (filters.priority) where.priority = filters.priority;

  return prisma.wealthSuggestion.findMany({
    where,
    orderBy: [{ score: 'desc' }, { created_at: 'desc' }],
  });
}

async function enqueueSuggestionGeneration(clientIds, rmId) {
  // Resolve client list — either from explicit ids or from rmId
  let clients;
  if (clientIds && clientIds.length > 0) {
    clients = await prisma.wealthClient.findMany({
      where:   { id: { in: clientIds } },
      include: { portfolio: true },
    });
  } else {
    clients = await prisma.wealthClient.findMany({
      where:   { rm_id: rmId },
      include: { portfolio: true },
    });
  }

  if (clients.length === 0) {
    const err = new Error('No clients found for the given criteria');
    err.status = 404;
    throw err;
  }

  // Score each client and build job payload entries
  const clientPayloads = clients.map(client => {
    const { score, components, priority } = computePriorityScore(client, client.portfolio);
    return {
      clientId:      client.id,
      clientData:    {
        id:               client.id,
        name:             client.name,
        segment:          client.segment,
        risk_profile:     client.risk_profile,
        engagement_score: client.engagement_score,
        churn_probability:client.churn_probability,
        last_contact_at:  client.last_contact_at,
      },
      portfolioData: client.portfolio ?? null,
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
      clients: batch,
      rmId:    rmId ?? null,
    });
    jobs.push({ id: job.id, status: 'pending', clientCount: batch.length });
  }

  return jobs;
}

async function updateSuggestionStatus(suggestionId, status, rmId) {
  const suggestion = await prisma.wealthSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) {
    const err = new Error('Suggestion not found');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.wealthSuggestion.update({
    where: { id: suggestionId },
    data:  { status, updated_at: new Date() },
  });

  await writeAuditLog('suggestion', suggestionId, status, rmId, { status });

  // If the RM acted on a suggestion, log it as an action
  if (status === 'used') {
    await prisma.wealthAction.create({
      data: {
        suggestion_id: suggestionId,
        client_id:     suggestion.client_id,
        rm_id:         rmId ?? null,
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
