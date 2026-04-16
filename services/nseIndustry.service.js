'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

async function createNseIndustryJob(subjectTicker) {
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

  return jobQueue.addJob('nse_industry', {
    subjectTicker,
    type: 'nse_industry',
  }, { jobId: `nse_industry_${subjectTicker}` });
}

async function fetchNseIndustryResult(subjectTicker) {
  return prisma.aiInsight.findUnique({
    where: { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
  });
}

module.exports = { createNseIndustryJob, fetchNseIndustryResult };
