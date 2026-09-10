'use strict';

const prisma   = require('../../config/prisma');
const { computePriorityScore } = require('./scoring.service');

const DASHBOARD_LIMIT = 20;
const INACTIVE_DAYS_THRESHOLD = 7;

async function getTodayPriorityList(orgId, rmProfileId) {
  const cutoff = new Date(Date.now() - INACTIVE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000);

  const clientWhere = {
    org_id: orgId,
    OR: [
      { last_contact_at: null },
      { last_contact_at: { lt: cutoff } },
      { churn_probability: { gt: 0.5 } },
    ],
  };

  if (rmProfileId) {
    clientWhere.rm_profile_id = rmProfileId;
  }

  // 1. Clients needing attention
  const clients = await prisma.wealthClient.findMany({
    where: clientWhere,
    include: {
      portfolio: {
        include: {
          holdings: {
            include: {
              alerts: { where: { is_resolved: false } },
            },
          },
        },
      },
      rm: {
        select: { id: true, display_name: true },
      },
    },
  });

  // Score each client
  const scored = clients.map((client) => {
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
          id:                client.id,
          name:              client.name,
          segment:           client.segment,
          risk_profile:      client.risk_profile,
          aum_cr:            client.aum_cr,
          last_contact_at:   client.last_contact_at,
          churn_probability: client.churn_probability,
          engagement_score:  client.engagement_score,
          rm:                client.rm,
        },
        score,
        priority,
        score_components: components,
        suggested_action: suggestion ?? null,
      };
    })
  );

  // 2. Open tasks for this RM/org
  const taskWhere = {
    org_id: orgId,
    status: { in: ['open', 'in_progress', 'overdue'] },
  };
  if (rmProfileId) {
    taskWhere.rm_profile_id = rmProfileId;
  }

  const tasks = await prisma.wealthTask.findMany({
    where:   taskWhere,
    take:    10,
    orderBy: [{ due_date: 'asc' }, { created_at: 'desc' }],
    include: {
      client: {
        select: { id: true, name: true },
      },
    },
  });

  // 3. Open opportunities
  const oppWhere = {
    org_id: orgId,
    status: 'open',
  };
  if (rmProfileId) {
    oppWhere.rm_profile_id = rmProfileId;
  }

  const opportunities = await prisma.wealthOpportunity.findMany({
    where:   oppWhere,
    take:    10,
    orderBy: { fit_score: 'desc' },
    include: {
      client: {
        select: { id: true, name: true, segment: true, aum_cr: true },
      },
    },
  });

  return {
    date:               new Date().toISOString().slice(0, 10),
    rm_profile_id:      rmProfileId || null,
    priority_list:      priorityList,
    tasks_today:        tasks,
    opportunities_today:opportunities,
  };
}

async function getDashboardSummary(orgId, wealthRole = null, rmProfileId = null) {
  const clientWhere = { org_id: orgId };
  const taskWhere = { org_id: orgId, status: { in: ['open', 'in_progress', 'overdue'] } };
  const oppWhere = { org_id: orgId, status: 'open' };

  if (wealthRole === 'rm' && rmProfileId) {
    clientWhere.rm_profile_id = rmProfileId;
    taskWhere.rm_profile_id = rmProfileId;
    oppWhere.rm_profile_id = rmProfileId;
  }

  const [clientAgg, tasksCount, oppAgg] = await Promise.all([
    prisma.wealthClient.aggregate({
      where:  clientWhere,
      _count: { id: true },
      _sum:   { aum_cr: true },
    }),
    prisma.wealthTask.count({ where: taskWhere }),
    prisma.wealthOpportunity.aggregate({
      where:  oppWhere,
      _count: { id: true },
      _sum:   { indicative_value_cr: true },
    }),
  ]);

  return {
    total_clients:      clientAgg._count.id,
    total_aum_cr:       clientAgg._sum.aum_cr || 0,
    open_tasks:         tasksCount,
    open_opportunities: oppAgg._count.id,
    opportunity_aum_cr: oppAgg._sum.indicative_value_cr || 0,
  };
}

module.exports = { getTodayPriorityList, getDashboardSummary };
