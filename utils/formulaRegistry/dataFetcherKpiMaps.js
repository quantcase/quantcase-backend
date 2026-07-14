'use strict';

// ── Single-period kpiMaps (from FinHelper.getProwessKpiMap / getProwessKpiMaps) ──

/**
 * Flat { [kpi_abbr]: number|null } map from the latest annual period.
 * Consolidated rows preferred over standalone (source_type ASC → 'C' < 'S').
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} companyName  — already-resolved prowess company name
 */
async function fetchKpiMap(prisma, companyName) {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (kpi_abbr)
           kpi_abbr, value, raw_value, multiplier
    FROM   prowess_values_new
    WHERE  company  = ${companyName}
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY kpi_abbr, fiscal_year DESC, quarter DESC, source_type ASC
  `;
  const map = {};
  for (const row of rows) {
    map[row.kpi_abbr] = row.value != null ? parseFloat(row.value) : null;
  }
  if (map['BORR_TOTAL'] == null && (map['DEBT_LT'] != null || map['DEBT_ST'] != null)) {
    map['BORR_TOTAL'] = (map['DEBT_LT'] ?? 0) + (map['DEBT_ST'] ?? 0);
  }
  return map;
}

/**
 * Returns { current, prev } kpiMaps from the latest two periods.
 * prev is null if only one period exists.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} companyName
 * @param {'annual'|'quarterly'} [source='annual']
 */
async function fetchKpiMaps(prisma, companyName, source = 'annual') {
  const callIdLike = source === 'quarterly' ? 'prowess_qtr_%' : 'prowess_new_%';
  const rows = await prisma.$queryRaw`
    SELECT kpi_abbr, value, fiscal_year, quarter, source_type
    FROM   prowess_values_new
    WHERE  company  = ${companyName}
      AND  call_id LIKE ${callIdLike}
    ORDER  BY fiscal_year DESC, quarter DESC, source_type ASC
  `;

  let latestFy = null, latestQtr = null, prevFy = null, prevQtr = null;
  for (const row of rows) {
    if (!latestFy) { latestFy = row.fiscal_year; latestQtr = row.quarter; continue; }
    if (row.fiscal_year === latestFy && row.quarter === latestQtr) continue;
    prevFy = row.fiscal_year; prevQtr = row.quarter;
    break;
  }

  const current = {}, prev = {};
  for (const row of rows) {
    const v = row.value != null ? parseFloat(row.value) : null;
    if (v == null) continue;
    if (row.fiscal_year === latestFy && row.quarter === latestQtr && !current[row.kpi_abbr]) {
      current[row.kpi_abbr] = v;
    } else if (row.fiscal_year === prevFy && row.quarter === prevQtr && !prev[row.kpi_abbr]) {
      prev[row.kpi_abbr] = v;
    }
  }

  for (const map of [current, prev]) {
    if (map['BORR_TOTAL'] == null && (map['DEBT_LT'] != null || map['DEBT_ST'] != null)) {
      map['BORR_TOTAL'] = (map['DEBT_LT'] ?? 0) + (map['DEBT_ST'] ?? 0);
    }
  }

  return {
    current,
    prev:          prevFy ? prev : null,
    currentPeriod: latestFy ? { fiscal_year: latestFy, quarter: latestQtr } : null,
    prevPeriod:    prevFy   ? { fiscal_year: prevFy,   quarter: prevQtr   } : null,
  };
}

/**
 * Returns an array of kpiMaps for the top N distinct periods plus one extra
 * (used as prevKpiMap for delta-type calculations in the last result entry).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} companyName
 * @param {'annual'|'quarterly'} [source='annual']
 * @param {number} [n=1]
 * @returns {Promise<Array<{ fiscal_year: string, quarter: string, kpiMap: object }>>}
 */
// Shared by fetchKpiMapsMulti and fetchKpiMapsMultiBatch — rows must already be
// scoped to one company, ordered fiscal_year DESC, quarter DESC, source_type ASC.
function _periodsFromRows(rows, n) {
  const periods = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.fiscal_year}|${row.quarter}`;
    if (!seen.has(key)) {
      seen.add(key);
      periods.push({ key, fiscal_year: row.fiscal_year, quarter: row.quarter, kpiMap: {} });
      if (periods.length === n + 1) break;
    }
  }
  if (!periods.length) return [];

  const byKey = Object.fromEntries(periods.map(p => [p.key, p.kpiMap]));
  for (const row of rows) {
    const key = `${row.fiscal_year}|${row.quarter}`;
    const km  = byKey[key];
    if (!km) continue;
    const v = row.value != null ? parseFloat(row.value) : null;
    if (v == null || km[row.kpi_abbr] !== undefined) continue;
    km[row.kpi_abbr] = v;
  }

  for (const p of periods) {
    const m = p.kpiMap;
    if (m['BORR_TOTAL'] == null && (m['DEBT_LT'] != null || m['DEBT_ST'] != null)) {
      m['BORR_TOTAL'] = (m['DEBT_LT'] ?? 0) + (m['DEBT_ST'] ?? 0);
    }
  }

  return periods.map(({ fiscal_year, quarter, kpiMap }) => ({ fiscal_year, quarter, kpiMap }));
}

async function fetchKpiMapsMulti(prisma, companyName, source = 'annual', n = 1) {
  const callIdLike = source === 'quarterly' ? 'prowess_qtr_%' : 'prowess_new_%';
  const rows = await prisma.$queryRaw`
    SELECT kpi_abbr, value, fiscal_year, quarter, source_type
    FROM   prowess_values_new
    WHERE  company  = ${companyName}
      AND  call_id LIKE ${callIdLike}
    ORDER  BY fiscal_year DESC, quarter DESC, source_type ASC
  `;
  return _periodsFromRows(rows, n);
}

/**
 * Bulk version of fetchKpiMapsMulti — one query for many companies instead of
 * one query per company. Built for screeners that scan hundreds of candidates
 * (see controllers/baskets.controller.js) where the per-company round-trip
 * latency, not DB query cost, dominates wall time.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} companyNames
 * @param {'annual'|'quarterly'} [source='annual']
 * @param {number} [n=1]
 * @returns {Promise<Object<string, Array<{ fiscal_year, quarter, kpiMap }>>>}  keyed by company name
 */
async function fetchKpiMapsMultiBatch(prisma, companyNames, source = 'annual', n = 1) {
  if (!companyNames.length) return {};
  const callIdLike = source === 'quarterly' ? 'prowess_qtr_%' : 'prowess_new_%';
  const rows = await prisma.$queryRaw`
    SELECT company, kpi_abbr, value, fiscal_year, quarter, source_type
    FROM   prowess_values_new
    WHERE  company  = ANY(${companyNames})
      AND  call_id LIKE ${callIdLike}
    ORDER  BY company, fiscal_year DESC, quarter DESC, source_type ASC
  `;

  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company)) byCompany.set(row.company, []);
    byCompany.get(row.company).push(row);
  }

  const result = {};
  for (const [company, companyRows] of byCompany) {
    const periods = _periodsFromRows(companyRows, n);
    if (periods.length) result[company] = periods;
  }
  return result;
}

module.exports = { fetchKpiMap, fetchKpiMaps, fetchKpiMapsMulti, fetchKpiMapsMultiBatch };
