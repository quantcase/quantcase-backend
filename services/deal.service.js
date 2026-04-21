'use strict';

const prisma                        = require('../config/prisma');
const { getPluginWithSkills, enqueueSkillJob } = require('./plugins.service');
const { FinHelper }                 = require('../utils/finHelper');
const { getDealResult }             = require('./db/deal.db');
const { mapToDealResponseSchema }   = require('../utils/dealMapper');

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

  const plugin  = await getPluginWithSkills('deal');
  if (!plugin) throw Object.assign(new Error('Plugin "deal" not found'), { status: 404 });
  const firstPs = plugin.pluginSkills[0];
  if (!firstPs) throw new Error('No active skills in "deal" plugin');

  const jobData = {
    callId,
    ticker,
    companyName:  call.company_name,
    industry,
    stockEps,
    stockPe,
    industryEps,
    industryPe,
    stockRev,
    stockRoce,
    industryRev,
    pluginSlug:  'deal',
    skillOrder:  firstPs.order,
    type:        firstPs.skill.slug,
    skillName:   firstPs.skill.slug,
  };

  const firstJob = await enqueueSkillJob('deal', firstPs, jobData);
  return { jobId: firstJob.id };
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
