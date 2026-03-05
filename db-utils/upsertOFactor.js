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

// Section → result key mapping
const SECTION_KEY_MAP = {
  industry:           'industry_overview',
  competition:        'competition',
  financial_strength: 'financial_strength',
  customer_traction:  'customer_traction',
};

/**
 * Merge a single section result into the stored OFactorResult record.
 * Creates the record if it doesn't exist yet.
 *
 * @param {string}  callId
 * @param {string}  subjectTicker
 * @param {string}  section        - one of: industry | competition | financial_strength | customer_traction
 * @param {object}  sectionResult  - the parsed LLM output for this section
 * @param {object}  [prismaClient] - optional shared PrismaClient
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
