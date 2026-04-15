'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

/** Extract ticker from callId format: TICKER_FYYYY_QX */
function tickerFromCallId(callId) {
  const idx = callId.indexOf('_FY');
  return idx > 0 ? callId.slice(0, idx) : callId;
}

async function createManagementJob(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { id: true },
  });
  if (!call) {
    const err = new Error('Earnings call not found');
    err.status = 404;
    throw err;
  }

  return jobQueue.addJob('management_analysis', {
    callId,
    type: 'management_analysis',
  });
}

async function fetchManagementResult(callId) {
  const ticker = tickerFromCallId(callId);
  return prisma.aiInsight.findUnique({
    where: { ticker_type: { ticker, type: 'management' } },
  });
}

module.exports = { createManagementJob, fetchManagementResult };
