'use strict';

/**
 * Admin CRUD for KpiFilter — a single, reusable threshold condition on a
 * Kpi's resolved value (e.g. "EBITDA > 10000"). Not tied to any one
 * CompanyGroup by itself; see admin.companyGroups.service.js's
 * attachFilter/detachFilter/recomputeGroup for how filters get combined
 * (AND) into a group's screening criteria via CompanyGroupFilter.
 */

const prisma = require('../config/prisma');
const { slugify } = require('../utils/slugify');

const OPERATORS = ['>', '<', '>=', '<=', '=', '!=', 'between'];

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function _validate({ kpi_abbr, operator, value, value_max }) {
  if (kpi_abbr) {
    const exists = await prisma.kpi.findUnique({ where: { abbr: kpi_abbr }, select: { abbr: true } });
    if (!exists) throw new HttpError(422, `kpi_abbr "${kpi_abbr}" does not exist.`);
  }
  if (operator && !OPERATORS.includes(operator)) {
    throw new HttpError(422, `operator must be one of: ${OPERATORS.join(', ')}.`);
  }
  if (operator === 'between' && value_max == null) {
    throw new HttpError(422, `value_max is required when operator is "between".`);
  }
}

async function listKpiFilters({ search, kpi_abbr } = {}) {
  return prisma.kpiFilter.findMany({
    where: {
      ...(kpi_abbr ? { kpi_abbr } : {}),
      ...(search ? { OR: [{ label: { contains: search, mode: 'insensitive' } }, { slug: { contains: search, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { slug: 'asc' },
  });
}

async function getKpiFilter(slug) {
  const filter = await prisma.kpiFilter.findUnique({ where: { slug } });
  if (!filter) throw new HttpError(404, `No KpiFilter with slug "${slug}".`);
  return filter;
}

async function createKpiFilter({ slug, label, kpi_abbr, operator, value, value_max, frequency }) {
  await _validate({ kpi_abbr, operator, value, value_max });

  const finalSlug = slug?.trim() || slugify(label);
  const existing = await prisma.kpiFilter.findUnique({ where: { slug: finalSlug } });
  if (existing) throw new HttpError(409, `KpiFilter with slug "${finalSlug}" already exists.`);

  return prisma.kpiFilter.create({
    data: {
      slug: finalSlug,
      label,
      kpi_abbr,
      operator,
      value,
      value_max: value_max ?? null,
      frequency: frequency ?? null,
    },
  });
}

async function updateKpiFilter(slug, patch) {
  const existing = await prisma.kpiFilter.findUnique({ where: { slug } });
  if (!existing) throw new HttpError(404, `No KpiFilter with slug "${slug}".`);

  await _validate({
    kpi_abbr:  'kpi_abbr'  in patch ? patch.kpi_abbr  : existing.kpi_abbr,
    operator:  'operator'  in patch ? patch.operator  : existing.operator,
    value:     'value'     in patch ? patch.value     : existing.value,
    value_max: 'value_max' in patch ? patch.value_max : existing.value_max,
  });

  const data = {};
  for (const field of ['label', 'kpi_abbr', 'operator', 'value', 'value_max', 'frequency']) {
    if (field in patch) data[field] = patch[field];
  }

  return prisma.kpiFilter.update({ where: { slug }, data });
}

async function deleteKpiFilter(slug) {
  const existing = await prisma.kpiFilter.findUnique({ where: { slug } });
  if (!existing) throw new HttpError(404, `No KpiFilter with slug "${slug}".`);
  // onDelete: Cascade on CompanyGroupFilter.kpi_filter — deleting a filter
  // also detaches it from any CompanyGroup it was attached to.
  await prisma.kpiFilter.delete({ where: { slug } });
}

module.exports = {
  listKpiFilters, getKpiFilter, createKpiFilter, updateKpiFilter, deleteKpiFilter,
  OPERATORS, HttpError,
};
