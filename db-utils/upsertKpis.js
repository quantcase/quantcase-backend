// db-utils/upsertKpis.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Processes KPIs from LLM extraction output:
 *   - Old KPIs  (in result.kpis but NOT in result.new_kpis): update industry only
 *   - New KPIs  (in result.new_kpis): insert with source + industry
 *
 * "Old" KPIs are derived efficiently as the set difference:
 *   result.kpis.kpi_abbr  \  new_kpis.abbr
 *
 * Handles two-pass insertion for new KPIs: standalone first, then ratios.
 *
 * @param {{ kpis: Array<{kpi_abbr: string}>, new_kpis: Array }} result
 * @param {string|null} industry  - e.g. call.basic_industry
 * @param {'transcript'|'QE'}    source
 * @returns {Promise<{ industryUpdated: string[], inserted: string[], skipped: string[], failed: Array<{abbr,error}> }>}
 */
async function upsertNewKpis(result, industry, source = 'transcript') {
  const kpis    = result?.kpis     ?? [];
  const newKpis = result?.new_kpis ?? [];

  const out = { industryUpdated: [], inserted: [], skipped: [], failed: [] };

  // Build set of new abbrs for O(1) lookups
  const newAbbrSet = new Set(newKpis.map(k => k.abbr));

  // ── Step 1: Update industry on existing (old) KPIs ──────────────────────────
  if (industry) {
    const oldAbbrs = kpis
      .map(k => k.kpi_abbr)
      .filter(abbr => abbr && !newAbbrSet.has(abbr));

    for (const abbr of oldAbbrs) {
      try {
        const row = await prisma.kpi.findUnique({ where: { abbr } });
        if (row && !row.industry.includes(industry)) {
          await prisma.kpi.update({
            where: { abbr },
            data:  { industry: { push: industry } }
          });
          out.industryUpdated.push(abbr);
        }
      } catch (err) {
        console.warn(`Failed to update industry for KPI ${abbr}:`, err.message);
      }
    }
  }

  if (!newKpis.length) return out;

  // ── Step 2: Validate new KPIs ────────────────────────────────────────────────
  const validated = [];
  for (const kpi of newKpis) {
    const error = validateKpi(kpi);
    if (error) out.failed.push({ abbr: kpi.abbr ?? 'UNKNOWN', error });
    else        validated.push(kpi);
  }

  const industryArr = industry ? [industry] : [];

  // Helper: if a new KPI row already exists, just patch its industry
  async function patchExisting(abbr) {
    if (!industry) return;
    const row = await prisma.kpi.findUnique({ where: { abbr } });
    if (row && !row.industry.includes(industry)) {
      await prisma.kpi.update({ where: { abbr }, data: { industry: { push: industry } } });
    }
  }

  // ── Pass 1: Standalone KPIs ──────────────────────────────────────────────────
  for (const kpi of validated.filter(k => k.type === 'standalone')) {
    try {
      const exists = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
      if (exists) { await patchExisting(kpi.abbr); out.skipped.push(kpi.abbr); continue; }

      await prisma.kpi.create({
        data: { abbr: kpi.abbr, full_form: kpi.full_form, type: 'standalone',
                denomination: kpi.denomination, source, industry: industryArr }
      });
      out.inserted.push(kpi.abbr);
    } catch (err) {
      out.failed.push({ abbr: kpi.abbr, error: err.message });
    }
  }

  // ── Pass 2: Ratio KPIs (numerator/denominator must exist already) ────────────
  for (const kpi of validated.filter(k => k.type === 'ratio')) {
    try {
      const exists = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
      if (exists) { await patchExisting(kpi.abbr); out.skipped.push(kpi.abbr); continue; }

      const numerator   = await prisma.kpi.findUnique({ where: { abbr: kpi.numerator_abbr } });
      const denominator = await prisma.kpi.findUnique({ where: { abbr: kpi.denominator_abbr } });

      if (!numerator) {
        out.failed.push({ abbr: kpi.abbr, error: `Numerator '${kpi.numerator_abbr}' not found` });
        continue;
      }
      if (!denominator) {
        out.failed.push({ abbr: kpi.abbr, error: `Denominator '${kpi.denominator_abbr}' not found` });
        continue;
      }

      await prisma.kpi.create({
        data: { abbr: kpi.abbr, full_form: kpi.full_form, type: 'ratio',
                numerator_id: numerator.id, denominator_id: denominator.id,
                source, industry: industryArr }
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
  if (!['standalone', 'ratio'].includes(kpi.type)) return `Invalid type: ${kpi.type}`;

  const validDenominations = ['INR', 'USD', 'percentage', 'days', 'times', 'units'];
  if (kpi.type === 'standalone') {
    if (!kpi.denomination || !validDenominations.includes(kpi.denomination))
      return `Invalid denomination: ${kpi.denomination}`;
  }
  if (kpi.type === 'ratio') {
    if (!kpi.numerator_abbr)   return 'Ratio KPI missing numerator_abbr';
    if (!kpi.denominator_abbr) return 'Ratio KPI missing denominator_abbr';
  }
  return null;
}

module.exports = { upsertNewKpis };
