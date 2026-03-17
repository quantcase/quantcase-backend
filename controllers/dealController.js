'use strict';

const prisma        = require('../lib/prisma');
const jobQueue      = require('../lib/jobQueue');
const { FinHelper } = require('../utils/finHelper');
const { getDealResult }          = require('../db-utils/upsertDealResult');
const { mapToDealResponseSchema } = require('../utils/dealMapper');

/**
 * POST /api/calls/:callId/deal/analysis
 *
 * 1. Computes stock + industry EPS/PE CAGR from DB via FinHelper.
 * 2. Enqueues a BullMQ 'deal_analysis' job with those inputs.
 * 3. Returns the job ID immediately (async — poll GET /api/calls/:callId/deal for result).
 */
async function createDealAnalysis(req, res) {
  try {
    const { callId } = req.params;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Deal] POST /deal/analysis  callId=${callId}`);

    const call = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { id: true, company: true, basic_industry: true, company_name: true, fiscal_year: true, quarter: true },
    });
    console.log(`[Deal] call record:`, call);

    if (!call) {
      return res.status(404).json({ success: false, error: 'Earnings call not found' });
    }

    const ticker   = call.company;
    const industry = call.basic_industry;
    const helper   = new FinHelper(prisma);

    console.log(`\n--- Computing inputs for ${ticker} ---`);
    const [stockEps, stockPe, industryEps, industryPe, stockRev, stockRoce, industryRev] = await Promise.all([
      helper.stockEpsCagr(ticker),
      helper.stockPeCagr(ticker),
      industry ? helper.industryEpsCagr(industry)  : Promise.resolve({ value: null, type: 'no_industry' }),
      industry ? helper.industryPeCagr(industry)   : Promise.resolve({ value: null, type: 'no_industry' }),
      helper.stockRevCagr(ticker),
      helper.stockRoceLatest(ticker),
      industry ? helper.industryRevCagr(industry)  : Promise.resolve({ value: null, type: 'no_industry' }),
    ]);

    console.log('\n--- Computed inputs ---');
    console.log('stockEps:',    stockEps);
    console.log('stockPe:',     stockPe);
    console.log('industryEps:', industryEps);
    console.log('industryPe:',  industryPe);
    console.log('stockRev:',    stockRev);
    console.log('stockRoce:',   stockRoce);
    console.log('industryRev:', industryRev);

    const bullmqJob = await jobQueue.addJob('deal_analysis', {
      callId,
      type:        'deal_analysis',
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
    }, { jobId: `deal_${callId}` });

    return res.json({
      success: true,
      message: 'Deal analysis job created and queued',
      job: {
        id:        bullmqJob.id,
        callId,
        type:      'deal_analysis',
        status:    'pending',
        createdAt: new Date(bullmqJob.timestamp).toISOString(),
      },
    });
  } catch (error) {
    console.error('[Deal] Error creating deal analysis job:', error);
    return res.status(500).json({
      success: false,
      error:   'Failed to create deal analysis job',
      message: error.message,
    });
  }
}

async function getDealAnalysis(req, res) {
  try {
    const { callId } = req.params;
    const record = await getDealResult(callId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Deal analysis not yet available — trigger via POST first' });
    }
    res.json({ success: true, data: mapToDealResponseSchema(record.result), inputs: record.inputs });
  } catch (error) {
    console.error('Error fetching deal result:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch deal result', message: error.message });
  }
}

async function getDealAnalysisByQuery(req, res) {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }
  try {
    const record = await getDealResult(callId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'No deal analysis available yet — trigger via POST first' });
    }
    res.json({ success: true, data: mapToDealResponseSchema(record.result), inputs: record.inputs });
  } catch (error) {
    console.error('Error fetching deal analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch deal analysis', message: error.message });
  }
}

module.exports = { createDealAnalysis, getDealAnalysis, getDealAnalysisByQuery };
