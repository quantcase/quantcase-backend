'use strict';

/**
 * Admin CRUD for KpiGroup — the display hierarchy that groups KPIs into
 * nested sections for screener tables/charts (parent/child, with siblings
 * being any nodes sharing a parent_id — no separate sibling concept needed).
 * Purely a layout concern; never consulted by utils/formulaRegistry's
 * resolver. See prisma/schema.prisma's KpiGroup docblock.
 */

const prisma = require('../config/prisma');
const { slugify } = require('../utils/slugify');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function _assertKpiExists(abbr) {
  if (!abbr) return;
  const exists = await prisma.kpi.findUnique({ where: { abbr }, select: { abbr: true } });
  if (!exists) throw new HttpError(422, `kpi_abbr "${abbr}" does not exist.`);
}

async function _assertCompanyGroupExists(slug) {
  if (!slug) return;
  const exists = await prisma.companyGroup.findUnique({ where: { slug }, select: { slug: true } });
  if (!exists) throw new HttpError(422, `company_group_slug "${slug}" does not exist.`);
}

/** True if `candidateParentId` is `nodeId` itself, or a descendant of it (i.e. reparenting there would create a cycle). */
async function _wouldCreateCycle(nodeId, candidateParentId) {
  if (!candidateParentId) return false;
  if (candidateParentId === nodeId) return true;
  let cur = await prisma.kpiGroup.findUnique({ where: { id: candidateParentId }, select: { id: true, parent_id: true } });
  const seen = new Set();
  while (cur) {
    if (cur.id === nodeId) return true;
    if (seen.has(cur.id)) break; // defensive, shouldn't happen
    seen.add(cur.id);
    if (!cur.parent_id) break;
    cur = await prisma.kpiGroup.findUnique({ where: { id: cur.parent_id }, select: { id: true, parent_id: true } });
  }
  return false;
}

function _buildTree(rows) {
  const byId = new Map(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const row of byId.values()) {
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id).children.push(row);
    } else {
      roots.push(row);
    }
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.display_order - b.display_order);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

async function listKpiGroups({ search, parent_id } = {}) {
  const where = {
    ...(parent_id !== undefined ? { parent_id: parent_id || null } : {}),
    ...(search
      ? { OR: [{ label: { contains: search, mode: 'insensitive' } }, { kpi_abbr: { contains: search, mode: 'insensitive' } }] }
      : {}),
  };
  return prisma.kpiGroup.findMany({ where, orderBy: [{ parent_id: 'asc' }, { display_order: 'asc' }] });
}

async function getKpiGroupTree() {
  const rows = await prisma.kpiGroup.findMany();
  return _buildTree(rows);
}

async function getKpiGroup(slug) {
  const group = await prisma.kpiGroup.findUnique({ where: { slug }, include: { children: { orderBy: { display_order: 'asc' } } } });
  if (!group) throw new HttpError(404, `No KpiGroup with slug "${slug}".`);
  return group;
}

async function createKpiGroup({ slug, label, parent_id, kpi_abbr, company_group_slug, display_order }) {
  const finalSlug = slug?.trim() || slugify(label);
  const existing = await prisma.kpiGroup.findUnique({ where: { slug: finalSlug } });
  if (existing) throw new HttpError(409, `KpiGroup with slug "${finalSlug}" already exists.`);

  if (parent_id) {
    const parent = await prisma.kpiGroup.findUnique({ where: { id: parent_id } });
    if (!parent) throw new HttpError(422, `parent_id "${parent_id}" does not exist.`);
  }
  await _assertKpiExists(kpi_abbr);
  await _assertCompanyGroupExists(company_group_slug);

  return prisma.kpiGroup.create({
    data: {
      slug: finalSlug,
      label,
      parent_id: parent_id ?? null,
      kpi_abbr: kpi_abbr ?? null,
      company_group_slug: company_group_slug ?? null,
      display_order: display_order ?? 0,
    },
  });
}

async function updateKpiGroup(slug, patch) {
  const existing = await prisma.kpiGroup.findUnique({ where: { slug } });
  if (!existing) throw new HttpError(404, `No KpiGroup with slug "${slug}".`);

  if ('parent_id' in patch && patch.parent_id) {
    const parent = await prisma.kpiGroup.findUnique({ where: { id: patch.parent_id } });
    if (!parent) throw new HttpError(422, `parent_id "${patch.parent_id}" does not exist.`);
    if (await _wouldCreateCycle(existing.id, patch.parent_id)) {
      throw new HttpError(422, `Reparenting "${slug}" under "${patch.parent_id}" would create a cycle.`);
    }
  }
  if ('kpi_abbr' in patch) await _assertKpiExists(patch.kpi_abbr);
  if ('company_group_slug' in patch) await _assertCompanyGroupExists(patch.company_group_slug);

  const data = {};
  for (const field of ['label', 'parent_id', 'kpi_abbr', 'company_group_slug', 'display_order']) {
    if (field in patch) data[field] = patch[field];
  }

  return prisma.kpiGroup.update({ where: { slug }, data });
}

async function deleteKpiGroup(slug) {
  const existing = await prisma.kpiGroup.findUnique({ where: { slug } });
  if (!existing) throw new HttpError(404, `No KpiGroup with slug "${slug}".`);
  // onDelete: Cascade on the self-relation FK takes care of descendants.
  await prisma.kpiGroup.delete({ where: { slug } });
}

module.exports = {
  listKpiGroups, getKpiGroupTree, getKpiGroup, createKpiGroup, updateKpiGroup, deleteKpiGroup,
  HttpError,
};
