const prisma = require('../lib/prisma');

function getPrisma() {
  return prisma;
}

/**
 * Upsert a deal analysis result.
 *
 * @param {string} callId
 * @param {string} ticker
 * @param {object} result  - Parsed Claude output (DealResponseSchema shape)
 * @param {object} inputs  - EPS/PE CAGR inputs used to generate the result
 * @param {object} [db]    - Optional shared PrismaClient instance (e.g. from worker)
 */
async function upsertDealResult(callId, ticker, result, inputs, db) {
  const client = db ?? getPrisma();
  return client.dealResult.upsert({
    where:  { callId },
    update: { result, inputs },
    create: { callId, ticker, result, inputs },
  });
}

/**
 * Fetch a stored deal result by callId.
 *
 * @param {string}  callId
 * @param {object}  [db]  - Optional shared PrismaClient instance
 */
async function getDealResult(callId, db) {
  const client = db ?? getPrisma();
  return client.dealResult.findUnique({ where: { callId } });
}

async function getLatestDealResult(db) {
  const client = db ?? getPrisma();
  return client.dealResult.findFirst({ orderBy: { updatedAt: 'desc' } });
}

module.exports = { upsertDealResult, getDealResult, getLatestDealResult };
