'use strict';

const prisma = require('../../config/prisma');

const THIRTY_DAYS_AGO = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function getRmPerformanceMetrics(rmId) {
  const rm = await prisma.wealthRmUser.findUnique({ where: { id: rmId } });
  if (!rm) {
    const err = new Error('RM user not found');
    err.status = 404;
    throw err;
  }

  const [
    clientStats,
    interactionCount,
    usedSuggestions,
    ignoredSuggestions,
    portfolioStats,
  ] = await Promise.all([
    prisma.wealthClient.aggregate({
      where:   { rm_id: rmId },
      _count:  { id: true },
      _avg:    { engagement_score: true, churn_probability: true },
    }),
    prisma.wealthInteraction.count({
      where: { rm_id: rmId, timestamp: { gte: THIRTY_DAYS_AGO() } },
    }),
    prisma.wealthSuggestion.count({
      where: {
        client: { rm_id: rmId },
        status: 'used',
        created_at: { gte: THIRTY_DAYS_AGO() },
      },
    }),
    prisma.wealthSuggestion.count({
      where: {
        client: { rm_id: rmId },
        status: 'ignored',
        created_at: { gte: THIRTY_DAYS_AGO() },
      },
    }),
    prisma.wealthPortfolio.aggregate({
      where: { client: { rm_id: rmId } },
      _avg:  { risk_score: true, total_value: true },
    }),
  ]);

  const totalSuggestions = usedSuggestions + ignoredSuggestions;
  const adoptionRate = totalSuggestions > 0
    ? Math.round((usedSuggestions / totalSuggestions) * 100) / 100
    : null;

  return {
    rm: { id: rm.id, name: rm.name, team: rm.team, performance_score: rm.performance_score },
    clients: {
      total:                clientStats._count.id,
      avg_engagement_score: clientStats._avg.engagement_score,
      avg_churn_probability:clientStats._avg.churn_probability,
    },
    interactions_last_30d:  interactionCount,
    suggestions_last_30d: {
      used:         usedSuggestions,
      ignored:      ignoredSuggestions,
      adoption_rate:adoptionRate,
    },
    portfolio: {
      avg_risk_score:  portfolioStats._avg.risk_score,
      avg_total_value: portfolioStats._avg.total_value,
    },
  };
}

async function getClientSegmentationAnalytics() {
  const [segmentGroups, interactionByType] = await Promise.all([
    prisma.wealthClient.groupBy({
      by:    ['segment'],
      _count:{ id: true },
      _avg:  { engagement_score: true, churn_probability: true },
    }),
    prisma.wealthInteraction.groupBy({
      by:    ['type'],
      where: { timestamp: { gte: THIRTY_DAYS_AGO() } },
      _count:{ id: true },
    }),
  ]);

  return {
    segments:              segmentGroups.map(g => ({
      segment:              g.segment,
      client_count:         g._count.id,
      avg_engagement_score: g._avg.engagement_score,
      avg_churn_probability:g._avg.churn_probability,
    })),
    interactions_last_30d: interactionByType.map(g => ({
      type:  g.type,
      count: g._count.id,
    })),
  };
}

module.exports = { getRmPerformanceMetrics, getClientSegmentationAnalytics };
