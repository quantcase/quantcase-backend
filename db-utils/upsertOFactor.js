const prisma = require('../lib/prisma');

function getPrisma() {
  return prisma;
}

/**
 * Upsert an OFactor analysis result.
 * Accepts an optional external prisma instance (e.g. from the worker) to avoid
 * opening extra connections when called from a long-running process.
 *
 * @param {string}   callId
 * @param {string}   subjectTicker
 * @param {string[]} peerTickers
 * @param {object}   result         - Parsed Claude output (OFactorResponseSchema shape)
 * @param {object}   [prisma]       - Optional shared PrismaClient instance
 */
async function upsertOFactorResult(callId, subjectTicker, peerTickers, result, prisma) {
  const db = prisma ?? getPrisma();
  return db.oFactorResult.upsert({
    where:  { callId },
    update: { result, peerTickers },
    create: { callId, subjectTicker, peerTickers, result },
  });
}

/**
 * Fetch a stored OFactor result by callId.
 *
 * @param {string}  callId
 * @param {object}  [prisma]  - Optional shared PrismaClient instance
 */
async function getOFactorResult(callId, prisma) {
  const db = prisma ?? getPrisma();
  return db.oFactorResult.findUnique({ where: { callId } });
}

/**
 * Fetch the most recently updated OFactor result for a given ticker.
 *
 * @param {string}  ticker
 * @param {object}  [prisma]  - Optional shared PrismaClient instance
 */
async function getLatestOFactorResultByTicker(ticker, prisma) {
  const db = prisma ?? getPrisma();
  return db.oFactorResult.findFirst({
    where:   { subjectTicker: ticker },
    orderBy: { updatedAt: 'desc' },
  });
}

module.exports = { upsertOFactorResult, getOFactorResult, getLatestOFactorResultByTicker };
