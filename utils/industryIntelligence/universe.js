'use strict';

const prisma      = require('../../config/prisma');
const { normName } = require('../prowessHelper');

/**
 * Load the scoring universe: one entry per ticker with basic_industry and company_name.
 * @returns {Promise<Array<{company: string, basic_industry: string, company_name: string|null}>>}
 */
async function loadUniverse() {
  const rows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: { not: null } },
    select:   { company: true, basic_industry: true, company_name: true },
    distinct: ['company'],
  });
  // Deduplicate: if a ticker appears in multiple rows take the first
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.company)) seen.set(r.company, r);
  }
  return [...seen.values()];
}

/**
 * Pre-warm the ProwessHelper name cache for all universe tickers using two bulk
 * queries instead of N×2 per-ticker resolution queries.
 *
 * @param {import('../prowessHelper').ProwessHelper} prowess
 * @param {Array<{company: string, company_name: string|null}>} universe
 */
async function warmProwessCache(prowess, universe) {
  const prowessRows = await prisma.prowessValueNew.findMany({
    select: { company: true }, distinct: ['company'],
  });

  const allProwessNames = prowessRows.map(r => ({
    original: r.company,
    norm:     normName(r.company),
  }));

  for (const { company: ticker, company_name } of universe) {
    if (prowess._nameCache.has(ticker)) continue;
    if (!company_name) { prowess._nameCache.set(ticker, null); continue; }

    const normTarget = normName(company_name);
    const words      = normTarget.split(' ').filter(w => w.length > 2);

    let best = null, bestScore = 0;
    for (const { original, norm } of allProwessNames) {
      if (!words.length) break;
      const matchCount = words.filter(w => norm.includes(w)).length;
      const score      = matchCount / words.length;
      if (score > bestScore && score >= 0.5) { bestScore = score; best = original; }
    }
    prowess._nameCache.set(ticker, best);
  }

  const matched = [...prowess._nameCache.values()].filter(v => v != null).length;
  console.log(`[IIT] Name cache: ${matched}/${universe.length} tickers matched to prowess`);
}

module.exports = { loadUniverse, warmProwessCache };
