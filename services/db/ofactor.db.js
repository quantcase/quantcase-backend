// services/db/ofactor.db.js
// Moved from db-utils/upsertOFactor.js

const prisma = require('../../config/prisma');

function getPrisma() {
  return prisma;
}

/**
 * Upsert an OFactor analysis result.
 * Accepts an optional external prisma instance (e.g. from the worker) to avoid
 * opening extra connections when called from a long-running process.
 */
async function upsertOFactorResult(callId, subjectTicker, peerTickers, result, prismaClient) {
  const db = prismaClient ?? getPrisma();
  return db.oFactorResult.upsert({
    where:  { callId },
    update: { result, peerTickers },
    create: { callId, subjectTicker, peerTickers, result },
  });
}

/**
 * Fetch a stored OFactor result by callId.
 */
async function getOFactorResult(callId, prismaClient) {
  const db = prismaClient ?? getPrisma();
  return db.oFactorResult.findUnique({ where: { callId } });
}

/**
 * Fetch the most recently updated OFactor result for a given ticker.
 */
async function getLatestOFactorResultByTicker(ticker, prismaClient) {
  const db = prismaClient ?? getPrisma();
  return db.oFactorResult.findFirst({
    where:   { subjectTicker: ticker },
    orderBy: { updatedAt: 'desc' },
  });
}

// Section → result key mapping
const SECTION_KEY_MAP = {
  industry:                    'industry_overview',
  competition:                 'competition',
  financial_strength:          'financial_strength',
  financial_strength_insights: 'financial_strength',  // merges extras into the same financial_strength record
  customer_traction:           'customer_traction',
  final_takeaways:             'final_takeaways',
};

/**
 * Merge a single section result into the stored OFactorResult record.
 * Creates the record if it doesn't exist yet.
 */
async function upsertOFactorSection(callId, subjectTicker, section, sectionResult, prismaClient) {
  const sectionKey = SECTION_KEY_MAP[section];
  if (!sectionKey) throw new Error(`Unknown OFactor section: "${section}"`);

  const db = prismaClient ?? getPrisma();
  const existing = await db.oFactorResult.findUnique({ where: { callId } });
  const currentResult = (existing?.result && typeof existing.result === 'object') ? existing.result : {};
  const mergedResult  = { ...currentResult, [sectionKey]: sectionResult };

  return db.oFactorResult.upsert({
    where:  { callId },
    update: { result: mergedResult },
    create: { callId, subjectTicker, peerTickers: [], result: mergedResult },
  });
}

module.exports = { upsertOFactorResult, upsertOFactorSection, getOFactorResult, getLatestOFactorResultByTicker };
