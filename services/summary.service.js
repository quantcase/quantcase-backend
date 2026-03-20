'use strict';

const prisma = require('../config/prisma');

async function getSummaryByCallId(callId) {
  return prisma.summaryNew.findFirst({
    where:   { callId },
    orderBy: { createdAt: 'desc' },
  });
}

module.exports = { getSummaryByCallId };
