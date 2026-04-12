'use strict';

const prisma             = require('../config/prisma');
const { enqueuePlugin }  = require('./plugins.service');
const { FinHelper }      = require('../utils/finHelper');
const { getDealResult }  = require('./db/deal.db');
const { mapToDealResponseSchema } = require('../utils/dealMapper');

async function createDealJob(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { id: true, company: true, basic_industry: true, company_name: true, fiscal_year: true, quarter: true },
  });
  if (!call) {
    const err = new Error('Earnings call not found');
    err.status = 404;
    throw err;
  }

  const ticker   = call.company;
  const industry = call.basic_industry;
  const helper   = new FinHelper(prisma);

  const [stockEps, stockPe, industryEps, industryPe, stockRev, stockRoce, industryRev] = await Promise.all([
    helper.stockEpsCagr(ticker),
    helper.stockPeCagr(ticker),
    industry ? helper.industryEpsCagr(industry)  : Promise.resolve({ value: null, type: 'no_industry' }),
    industry ? helper.industryPeCagr(industry)   : Promise.resolve({ value: null, type: 'no_industry' }),
    helper.stockRevCagr(ticker),
    helper.stockRoceLatest(ticker),
    industry ? helper.industryRevCagr(industry)  : Promise.resolve({ value: null, type: 'no_industry' }),
  ]);

  const enqueuedJobs = await enqueuePlugin('deal', {
    callId,
    ticker,
    companyName: call.company_name,
    industry,
    stockEps,
    stockPe,
    industryEps,
    industryPe,
    stockRev,
    stockRoce,
    industryRev,
  });

  // Return the first enqueued job to match prior API contract
  return enqueuedJobs[0];
}

async function fetchDealResult(callId) {
  return getDealResult(callId);
}

function formatDealResult(record) {
  return {
    data:   mapToDealResponseSchema(record.result),
    inputs: record.inputs,
  };
}

module.exports = { createDealJob, fetchDealResult, formatDealResult };
