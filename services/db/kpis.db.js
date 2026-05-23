// services/db/kpis.db.js
// Moved from db-utils/upsertKpis.js

const prisma = require('../../config/prisma');

/**
 * Strip any LLM-injected "new_kpis" prefix variants from an abbr and uppercase it.
 * The LLM sometimes echoes the output-array key ("new_kpis") back into the abbr string,
 * producing cascading garbage like "new_kpis:new_kpis:CAPEX" or "new_kpis/CAPEX".
 * We normalize before any DB lookup so these are deduplicated against clean existing rows.
 */
function normalizeAbbr(abbr) {
  if (typeof abbr !== 'string') return abbr;
  let a = abbr.trim();
  const prefix = /^new_kpis[:/_.\-]/i;
  while (prefix.test(a)) a = a.replace(prefix, '').trim();
  return a.toUpperCase();
}

/**
 * Collects all KPI abbrs that were referenced in the LLM output
 * (excluding new_kpis — those are handled separately).
 */
function extractUsedAbbrs(result, newAbbrSet) {
  const abbrs = new Set();

  const addFromList = (list) => {
    for (const item of list ?? []) {
      if (item?.kpi_abbr && !newAbbrSet.has(item.kpi_abbr)) abbrs.add(item.kpi_abbr);
    }
  };

  // industry_analysis
  const ia = result.industry_analysis ?? {};
  addFromList(ia.demand?.kpis);
  addFromList(ia.supply?.kpis);
  addFromList(ia.operating_margins?.kpis);

  // client_traction
  const ct = result.client_traction ?? {};
  addFromList(ct.customer_growth?.kpis);
  addFromList(ct.revenue_streams?.kpis);

  // milestones
  const ms = result.milestones ?? {};
  for (const category of ['future_goals', 'failure_disclosures', 'success_disclosures']) {
    addFromList(ms[category]?.financial_targets);
  }

  return abbrs;
}

/**
 * Processes KPIs from LLM extraction output:
 *   - Existing KPIs referenced in the output: update industry array
 *   - new_kpis: insert with kpi_type, denomination, source, industry
 *
 * @param {object} result  - parsed LLM output
 * @param {string|null} industry  - e.g. call.basic_industry
 * @param {'transcript'|'QE'} source
 * @returns {Promise<{ industryUpdated: string[], inserted: string[], skipped: string[], failed: Array<{abbr,error}> }>}
 */
async function upsertNewKpis(result, industry, source = 'transcript') {
  const newKpis = result?.new_kpis ?? [];
  const out = { industryUpdated: [], inserted: [], skipped: [], failed: [] };

  const newAbbrSet = new Set(newKpis.map(k => k.abbr));

  // ── Step 1: Update industry on existing KPIs referenced in the output ─────
  if (industry) {
    const usedAbbrs = extractUsedAbbrs(result, newAbbrSet);
    for (const abbr of usedAbbrs) {
      try {
        const row = await prisma.kpi.findUnique({ where: { abbr } });
        if (row && !row.industry.includes(industry)) {
          await prisma.kpi.update({ where: { abbr }, data: { industry: { push: industry } } });
          out.industryUpdated.push(abbr);
        }
      } catch (err) {
        console.warn(`Failed to update industry for KPI ${abbr}:`, err.message);
      }
    }
  }

  if (!newKpis.length) return out;

  // ── Step 2: Validate new KPIs ─────────────────────────────────────────────
  const validated = [];
  for (const kpi of newKpis) {
    const cleanAbbr = normalizeAbbr(kpi.abbr);
    const error = validateKpi({ ...kpi, abbr: cleanAbbr });
    if (error) out.failed.push({ abbr: cleanAbbr ?? 'UNKNOWN', error });
    else        validated.push({ ...kpi, abbr: cleanAbbr });
  }

  const industryArr = industry ? [industry] : [];

  // ── Step 3: Insert new KPIs ───────────────────────────────────────────────
  for (const kpi of validated) {
    try {
      const exists = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
      if (exists) {
        // Already exists — just patch industry if needed
        if (industry && !exists.industry.includes(industry)) {
          await prisma.kpi.update({ where: { abbr: kpi.abbr }, data: { industry: { push: industry } } });
        }
        out.skipped.push(kpi.abbr);
        continue;
      }

      await prisma.kpi.create({
        data: {
          abbr:         kpi.abbr,
          full_form:    kpi.full_form,
          kpi_type:     kpi.kpi_type,
          denomination: kpi.denomination,
          source,
          industry:     industryArr
        }
      });
      out.inserted.push(kpi.abbr);
    } catch (err) {
      out.failed.push({ abbr: kpi.abbr, error: err.message });
    }
  }

  return out;
}

/**
 * Validates a single new_kpi entry from LLM output.
 * Returns an error string if invalid, null if valid.
 */
function validateKpi(kpi) {
  if (!kpi.abbr || typeof kpi.abbr !== 'string') return 'Missing or invalid abbr';
  if (!kpi.full_form || typeof kpi.full_form !== 'string') return 'Missing full_form';
  if (!['customer_kpis', 'industry_specific'].includes(kpi.kpi_type))
    return `Invalid kpi_type: ${kpi.kpi_type}`;
  if (!['rupee', 'percentage', 'ratio', 'other'].includes(kpi.denomination))
    return `Invalid denomination: ${kpi.denomination}`;
  return null;
}

module.exports = { upsertNewKpis };
