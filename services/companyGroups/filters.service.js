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
const { resolveMetric, createMultiCompanyResolutionContext } = require('../../utils/formulaRegistry');
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
 * known company and repopulates CompanyGroupMember. Companies are resolved
 * in batches via createMultiCompanyResolutionContext (a handful of bulk
 * queries per batch, covering every company in that batch at once) rather
 * than self-fetching one company at a time — the old per-company approach
 * (createResolutionContext + a bounded worker pool) issued 2-8+ DB round
 * trips per company sequentially; for the ~2k-company universe that was
 * enough to exhaust prisma's connection pool (connection_limit=10 against
 * the pgbouncer pooler — see .env) or outlive Supabase's statement timeout
 * partway through, without ever finishing. Batched (rather than one
 * multi-company call for the whole universe) to keep each batch's
 * result-set size and query duration bounded.
 *
 * Note: createMultiCompanyResolutionContext only serves current-value
 * resolution for daily-native abbrs (PRICE/PE_DAILY/MCAP_SNAPSHOT) — a
 * KpiFilter on a CAGR/AVG/SUM formula over one of those abbrs won't resolve
 * correctly here (see that function's own docblock in resolutionContext.js).
 * Not a concern for any filter today (all reference Prowess-backed
 * annual/quarterly KPIs), but worth knowing if a daily-derived filter is
 * ever added.
 *
 * Meant to be triggered on demand (after editing a group's filters), not on
 * a hot request path.
 */
async function recomputeGroup(slug, { batchSize = 100 } = {}) {
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

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const contexts = await createMultiCompanyResolutionContext({ symbols: batch });
      for (const symbol of batch) {
        const ctx = contexts.get(symbol);
        let ok = true;
        for (const att of attachments) {
          const f = att.kpi_filter;
          // admin.kpiFilters.routes.js requires frequency on every newly
          // created filter — a null here can only be a pre-existing filter
          // from before that was enforced. resolveMetric has no fallback
          // frequency to guess (see financial.js's top docblock), so it
          // cleanly resolves to null rather than guessing a cadence, which
          // just makes that filter never match instead of crashing.
          const opts = f.frequency ? { frequency: f.frequency } : {};
          const { value } = await resolveMetric(f.kpi_abbr, ctx, opts);
          if (!_passesFilter(value, f)) { ok = false; break; }
        }
        if (ok) matched.push(symbol);
      }
    }
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
