// utils/kpi/upsertKpis.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Takes the new_kpis array from LLM output and upserts into the kpis table.
 * Handles two-pass insertion: standalone KPIs first, then ratios
 * (since ratio rows reference other KPI IDs that must exist first).
 *
 * @param {Array} newKpis - new_kpis array from LLM JSON output
 * @returns {Promise<{ inserted: string[], skipped: string[], failed: Array<{abbr, error}> }>}
 */
async function upsertNewKpis(newKpis) {
  if (!newKpis || newKpis.length === 0) {
    return { inserted: [], skipped: [], failed: [] };
  }

  const results = { inserted: [], skipped: [], failed: [] };

  // Validate each entry before touching the DB
  const validated = [];
  for (const kpi of newKpis) {
    const error = validateKpi(kpi);
    if (error) {
      results.failed.push({ abbr: kpi.abbr ?? 'UNKNOWN', error });
    } else {
      validated.push(kpi);
    }
  }

  // --- Pass 1: Insert standalone KPIs ---
  const standalones = validated.filter(k => k.type === 'standalone');
  for (const kpi of standalones) {
    try {
      const existing = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
      if (existing) {
        results.skipped.push(kpi.abbr);
        continue;
      }
      await prisma.kpi.create({
        data: {
          abbr:        kpi.abbr,
          full_form:   kpi.full_form,
          type:        'standalone',
          denomination: kpi.denomination
        }
      });
      results.inserted.push(kpi.abbr);
    } catch (err) {
      results.failed.push({ abbr: kpi.abbr, error: err.message });
    }
  }

  // --- Pass 2: Insert ratio KPIs (their numerator/denominator must exist by now) ---
  const ratios = validated.filter(k => k.type === 'ratio');
  for (const kpi of ratios) {
    try {
      const existing = await prisma.kpi.findUnique({ where: { abbr: kpi.abbr } });
      if (existing) {
        results.skipped.push(kpi.abbr);
        continue;
      }

      // Resolve numerator and denominator IDs
      const numerator = await prisma.kpi.findUnique({ where: { abbr: kpi.numerator_abbr } });
      const denominator = await prisma.kpi.findUnique({ where: { abbr: kpi.denominator_abbr } });

      if (!numerator) {
        results.failed.push({ abbr: kpi.abbr, error: `Numerator KPI '${kpi.numerator_abbr}' not found in DB` });
        continue;
      }
      if (!denominator) {
        results.failed.push({ abbr: kpi.abbr, error: `Denominator KPI '${kpi.denominator_abbr}' not found in DB` });
        continue;
      }

      await prisma.kpi.create({
        data: {
          abbr:           kpi.abbr,
          full_form:      kpi.full_form,
          type:           'ratio',
          numerator_id:   numerator.id,
          denominator_id: denominator.id
        }
      });
      results.inserted.push(kpi.abbr);
    } catch (err) {
      results.failed.push({ abbr: kpi.abbr, error: err.message });
    }
  }

  return results;
}

/**
 * Validates a single KPI object from LLM output.
 * Returns an error string if invalid, null if valid.
 */
function validateKpi(kpi) {
  if (!kpi.abbr || typeof kpi.abbr !== 'string') return 'Missing or invalid abbr';
  if (!kpi.full_form || typeof kpi.full_form !== 'string') return 'Missing full_form';
  if (!['standalone', 'ratio'].includes(kpi.type)) return `Invalid type: ${kpi.type}`;

  const validDenominations = ['INR', 'USD', 'percentage', 'days', 'times', 'units'];

  if (kpi.type === 'standalone') {
    if (!kpi.denomination || !validDenominations.includes(kpi.denomination)) {
      return `Standalone KPI must have a valid denomination. Got: ${kpi.denomination}`;
    }
  }

  if (kpi.type === 'ratio') {
    if (!kpi.numerator_abbr) return 'Ratio KPI missing numerator_abbr';
    if (!kpi.denominator_abbr) return 'Ratio KPI missing denominator_abbr';
  }

  return null;
}

module.exports = { upsertNewKpis };