'use strict';

const prisma   = require('../../config/prisma');
const { computePriorityScore } = require('./scoring.service');

const DASHBOARD_LIMIT    = 20;
const INACTIVE_DAYS_THRESHOLD = 7;

async function getTodayPriorityList(rmId) {
  const cutoff = new Date(Date.now() - INACTIVE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000);

  // Clients not contacted in 7 days OR high churn risk
  const clients = await prisma.wealthClient.findMany({
    where: {
      rm_id: rmId,
      OR: [
        { last_contact_at: null },
        { last_contact_at: { lt: cutoff } },
        { churn_probability: { gt: 0.5 } },
      ],
    },
    include: { portfolio: true },
  });

  // Score each client
  const scored = clients.map(client => {
    const { score, components, priority } = computePriorityScore(client, client.portfolio);
    return { client, score, components, priority };
  });

  // Sort by score descending and take top N
  scored.sort((a, b) => b.score - a.score);
  const topClients = scored.slice(0, DASHBOARD_LIMIT);

  // Fetch latest pending suggestion for each
  const priorityList = await Promise.all(
    topClients.map(async ({ client, score, components, priority }) => {
      const suggestion = await prisma.wealthSuggestion.findFirst({
        where:   { client_id: client.id, status: 'pending' },
        orderBy: { score: 'desc' },
      });

      return {
        client: {
          id:               client.id,
          name:             client.name,
          segment:          client.segment,
          risk_profile:     client.risk_profile,
          last_contact_at:  client.last_contact_at,
          churn_probability:client.churn_probability,
          engagement_score: client.engagement_score,
        },
        score,
        priority,
        score_components:  components,
        suggested_action:  suggestion ?? null,
      };
    })
  );

  return {
    date:          new Date().toISOString().slice(0, 10),
    rm_id:         rmId,
    priority_list: priorityList,
  };
}

module.exports = { getTodayPriorityList };
