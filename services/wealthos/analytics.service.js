'use strict';

const prisma = require('../../config/prisma');

const THIRTY_DAYS_AGO = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function getRmPerformanceMetrics(orgId, rmProfileId) {
  const rm = await prisma.wealthRmProfile.findFirst({
    where: { id: rmProfileId, org_id: orgId },
  });
  if (!rm) {
    const err = new Error('RM profile not found');
    err.status = 404;
    throw err;
  }

  const [
    clientStats,
    interactionCount,
    usedSuggestions,
    ignoredSuggestions,
    portfolioStats,
    openTasksCount,
    openOppsCount,
  ] = await Promise.all([
    prisma.wealthClient.aggregate({
      where:   { rm_profile_id: rmProfileId, org_id: orgId },
      _count:  { id: true },
      _avg:    { engagement_score: true, churn_probability: true },
      _sum:    { aum_cr: true },
    }),
    prisma.wealthInteraction.count({
      where: { rm_profile_id: rmProfileId, org_id: orgId, timestamp: { gte: THIRTY_DAYS_AGO() } },
    }),
    prisma.wealthSuggestion.count({
      where: {
        client:     { rm_profile_id: rmProfileId, org_id: orgId },
        status:     'used',
        created_at: { gte: THIRTY_DAYS_AGO() },
      },
    }),
    prisma.wealthSuggestion.count({
      where: {
        client:     { rm_profile_id: rmProfileId, org_id: orgId },
        status:     'ignored',
        created_at: { gte: THIRTY_DAYS_AGO() },
      },
    }),
    prisma.wealthPortfolio.aggregate({
      where: { client: { rm_profile_id: rmProfileId, org_id: orgId } },
      _avg:  { risk_score: true, total_value_cr: true },
      _sum:  { total_value_cr: true },
    }),
    prisma.wealthTask.count({
      where: { rm_profile_id: rmProfileId, org_id: orgId, status: { in: ['open', 'in_progress', 'overdue'] } },
    }),
    prisma.wealthOpportunity.count({
      where: { rm_profile_id: rmProfileId, org_id: orgId, status: 'open' },
    }),
  ]);

  const totalSuggestions = usedSuggestions + ignoredSuggestions;
  const adoptionRate = totalSuggestions > 0
    ? Math.round((usedSuggestions / totalSuggestions) * 100) / 100
    : null;

  return {
    rm: {
      id:                rm.id,
      display_name:      rm.display_name,
      team:              rm.team,
      performance_score: rm.performance_score,
      target_aum_cr:     rm.target_aum_cr,
      total_aum_cr:      clientStats._sum.aum_cr || rm.total_aum_cr || 0,
    },
    clients: {
      total:                 clientStats._count.id,
      avg_engagement_score:  clientStats._avg.engagement_score ? Math.round(clientStats._avg.engagement_score * 10) / 10 : 0,
      avg_churn_probability: clientStats._avg.churn_probability ? Math.round(clientStats._avg.churn_probability * 100) / 100 : 0,
      total_aum_cr:          clientStats._sum.aum_cr || 0,
    },
    interactions_last_30d:  interactionCount,
    suggestions_last_30d: {
      used:          usedSuggestions,
      ignored:       ignoredSuggestions,
      adoption_rate: adoptionRate,
    },
    portfolio: {
      avg_risk_score:  portfolioStats._avg.risk_score ? Math.round(portfolioStats._avg.risk_score * 10) / 10 : null,
      avg_total_value: portfolioStats._avg.total_value_cr || 0,
      sum_total_value: portfolioStats._sum.total_value_cr || 0,
    },
    workload: {
      open_tasks:         openTasksCount,
      open_opportunities: openOppsCount,
    },
  };
}

async function getClientSegmentationAnalytics(orgId) {
  const [segmentGroups, interactionByType, riskGroups, statusGroups] = await Promise.all([
    prisma.wealthClient.groupBy({
      by:    ['segment'],
      where: { org_id: orgId },
      _count:{ id: true },
      _sum:  { aum_cr: true },
      _avg:  { engagement_score: true, churn_probability: true },
    }),
    prisma.wealthInteraction.groupBy({
      by:    ['type'],
      where: { org_id: orgId, timestamp: { gte: THIRTY_DAYS_AGO() } },
      _count:{ id: true },
    }),
    prisma.wealthClient.groupBy({
      by:    ['risk_profile'],
      where: { org_id: orgId },
      _count:{ id: true },
      _sum:  { aum_cr: true },
    }),
    prisma.wealthClient.groupBy({
      by:    ['lifecycle_status'],
      where: { org_id: orgId },
      _count:{ id: true },
      _sum:  { aum_cr: true },
    }),
  ]);

  return {
    segments: segmentGroups.map(g => ({
      segment:               g.segment,
      client_count:          g._count.id,
      total_aum_cr:          g._sum.aum_cr || 0,
      avg_engagement_score:  g._avg.engagement_score ? Math.round(g._avg.engagement_score * 10) / 10 : 0,
      avg_churn_probability: g._avg.churn_probability ? Math.round(g._avg.churn_probability * 100) / 100 : 0,
    })),
    interactions_last_30d: interactionByType.map(g => ({
      type:  g.type,
      count: g._count.id,
    })),
    risk_profiles: riskGroups.map(g => ({
      risk_profile: g.risk_profile,
      client_count: g._count.id,
      total_aum_cr: g._sum.aum_cr || 0,
    })),
    lifecycle_stages: statusGroups.map(g => ({
      lifecycle_status: g.lifecycle_status,
      client_count:     g._count.id,
      total_aum_cr:     g._sum.aum_cr || 0,
    })),
  };
}

async function getFirmSummaryAnalytics(orgId) {
  const [clientAgg, rmCount, taskCount, oppAgg] = await Promise.all([
    prisma.wealthClient.aggregate({
      where: { org_id: orgId },
      _count: { id: true },
      _sum:   { aum_cr: true },
      _avg:   { churn_probability: true },
    }),
    prisma.wealthRmProfile.count({ where: { org_id: orgId } }),
    prisma.wealthTask.count({ where: { org_id: orgId, status: { in: ['open', 'in_progress', 'overdue'] } } }),
    prisma.wealthOpportunity.aggregate({
      where: { org_id: orgId, status: 'open' },
      _count: { id: true },
      _sum:   { indicative_value_cr: true },
    }),
  ]);

  return {
    total_aum_cr:        clientAgg._sum.aum_cr || 0,
    total_clients:       clientAgg._count.id,
    total_rms:           rmCount,
    avg_churn_risk:      clientAgg._avg.churn_probability ? Math.round(clientAgg._avg.churn_probability * 100) / 100 : 0,
    open_tasks:          taskCount,
    open_opportunities:  oppAgg._count.id,
    opportunity_aum_cr:  oppAgg._sum.indicative_value_cr || 0,
  };
}

module.exports = {
  getRmPerformanceMetrics,
  getClientSegmentationAnalytics,
  getFirmSummaryAnalytics,
};
