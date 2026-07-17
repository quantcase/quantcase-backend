'use strict';

/**
 * KpiFilter <-> CompanyGroup attachment and recompute, for CompanyGroup rows
 * with filter_type: 'kpi_filter'. Evaluating a KPI condition against every
 * company is expensive, so unlike 'manual'/'dynamic' groups (recomputed
 * live-ish, behind resolver.js's short-TTL cache), 'kpi_filter' membership is
 * computed once here (admin-triggered) into CompanyGroupMember; resolveGroup()
 * reads that table directly instead of evaluating filters itself. See
 * prisma/schema.prisma's CompanyGroupFilter/CompanyGroupMember docblocks.
 */

const prisma = require('../../config/prisma');
const { resolveMetric, createResolutionContext } = require('../../utils/formulaRegistry');
const { invalidateGroupCache } = require('./resolver');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function notFoundGroup(slug) {
  return new HttpError(404, `Company group "${slug}" not found.`);
}

async function _getGroup(slug) {
  const group = await prisma.companyGroup.findUnique({ where: { slug } });
  if (!group) throw notFoundGroup(slug);
  return group;
}

function _passesFilter(value, filter) {
  if (value == null) return false;
  switch (filter.operator) {
    case '>':  return value > filter.value;
    case '<':  return value < filter.value;
    case '>=': return value >= filter.value;
    case '<=': return value <= filter.value;
    case '=':  return value === filter.value;
    case '!=': return value !== filter.value;
    case 'between': return filter.value_max != null && value >= filter.value && value <= filter.value_max;
    default: return false;
  }
}

async function listAttachedFilters(slug) {
  await _getGroup(slug);
  return prisma.companyGroupFilter.findMany({
    where: { company_group_slug: slug },
    include: { kpi_filter: true },
    orderBy: { created_at: 'asc' },
  });
}

async function attachFilter(slug, { kpi_filter_id, kpi_filter_slug }) {
  await _getGroup(slug);

  const kpiFilter = kpi_filter_id
    ? await prisma.kpiFilter.findUnique({ where: { id: kpi_filter_id } })
    : await prisma.kpiFilter.findUnique({ where: { slug: kpi_filter_slug } });
  if (!kpiFilter) throw new HttpError(422, `No KpiFilter matching "${kpi_filter_id ?? kpi_filter_slug}".`);

  const existing = await prisma.companyGroupFilter.findUnique({
    where: { company_group_slug_kpi_filter_id: { company_group_slug: slug, kpi_filter_id: kpiFilter.id } },
  });
  if (existing) throw new HttpError(409, `Filter "${kpiFilter.slug}" is already attached to "${slug}".`);

  const created = await prisma.companyGroupFilter.create({
    data: { company_group_slug: slug, kpi_filter_id: kpiFilter.id },
    include: { kpi_filter: true },
  });
  invalidateGroupCache(slug);
  return created;
}

async function detachFilter(slug, attachmentId) {
  await _getGroup(slug);
  const existing = await prisma.companyGroupFilter.findUnique({ where: { id: attachmentId } });
  if (!existing || existing.company_group_slug !== slug) {
    throw new HttpError(404, `No filter attachment "${attachmentId}" on "${slug}".`);
  }
  await prisma.companyGroupFilter.delete({ where: { id: attachmentId } });
  invalidateGroupCache(slug);
}

/**
 * Evaluates every filter attached to `slug` (AND-combined) against every
 * known company and repopulates CompanyGroupMember. Runs with bounded
 * concurrency since it self-fetches per-company data via
 * createResolutionContext — for the full ~2k-company universe this can take
 * a while; it's meant to be triggered on demand (after editing a group's
 * filters), not on a hot request path.
 */
async function recomputeGroup(slug, { concurrency = 8 } = {}) {
  const group = await _getGroup(slug);
  if (group.filter_type !== 'kpi_filter') {
    throw new HttpError(422, `Company group "${slug}" has filter_type "${group.filter_type}", not "kpi_filter" — recompute only applies to kpi_filter groups.`);
  }

  const attachments = await prisma.companyGroupFilter.findMany({
    where: { company_group_slug: slug },
    include: { kpi_filter: true },
  });

  let matched = [];
  if (attachments.length) {
    const companies = await prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] });
    const symbols = companies.map(c => c.company).filter(Boolean);

    let idx = 0;
    async function worker() {
      const hits = [];
      while (idx < symbols.length) {
        const symbol = symbols[idx++];
        const ctx = createResolutionContext({ symbol });
        let ok = true;
        for (const att of attachments) {
          const f = att.kpi_filter;
          const opts = f.frequency ? { frequency: f.frequency } : {};
          const { value } = await resolveMetric(f.kpi_abbr, ctx, opts);
          if (!_passesFilter(value, f)) { ok = false; break; }
        }
        if (ok) hits.push(symbol);
      }
      return hits;
    }
    const results = await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) || 1 }, worker));
    matched = results.flat();
  }

  await prisma.$transaction([
    prisma.companyGroupMember.deleteMany({ where: { company_group_slug: slug } }),
    ...(matched.length
      ? [prisma.companyGroupMember.createMany({ data: matched.map(symbol => ({ company_group_slug: slug, symbol })) })]
      : []),
  ]);
  // resolveGroup() caches its output for up to 60s (see resolver.js) — without
  // this, a fresh recompute could still serve the pre-recompute member list
  // for up to a minute.
  invalidateGroupCache(slug);

  return { matched: matched.length, symbols: matched.sort() };
}

module.exports = { listAttachedFilters, attachFilter, detachFilter, recomputeGroup, HttpError };
