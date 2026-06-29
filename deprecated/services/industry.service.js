'use strict';

const prisma = require('../config/prisma');

const OFACTOR_TYPES = ['nse_industry', 'competition', 'financial_strength', 'customer_traction', 'final_takeaways'];

async function fetchIndustryResult(subjectTicker) {
  const rows = await prisma.aiInsight.findMany({
    where:   { ticker: subjectTicker, type: { in: OFACTOR_TYPES } },
    orderBy: { type: 'asc' },
  });
  if (!rows.length) return null;
  const data      = Object.fromEntries(rows.map(r => [r.type, r.insight]));
  const analyzedAt = rows.reduce((latest, r) => r.updated_at > latest ? r.updated_at : latest, rows[0].updated_at);
  return { data, analyzedAt };
}

module.exports = { fetchIndustryResult };
