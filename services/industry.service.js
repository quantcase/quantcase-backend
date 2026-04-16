'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

async function createIndustryJob(subjectTicker) {
  const call = await prisma.earnings_calls.findFirst({
    where:  { company: subjectTicker },
    select: { id: true, basic_industry: true },
  });
  if (!call) {
    const err = new Error('Ticker not found in earnings calls');
    err.status = 404;
    throw err;
  }
  if (!call.basic_industry) {
    const err = new Error('No basic_industry mapped for this ticker');
    err.status = 400;
    throw err;
  }

  return jobQueue.addJob('ofactor_analysis', {
    subjectTicker,
    type: 'industry',
  }, { jobId: `industry_${subjectTicker}` });
}

const OFACTOR_TYPES = ['industry', 'competition', 'financial_strength', 'customer_traction', 'final_takeaways'];

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

module.exports = { createIndustryJob, fetchIndustryResult };
