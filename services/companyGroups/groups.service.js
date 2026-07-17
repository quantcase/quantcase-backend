'use strict';

const prisma = require('../../config/prisma');
const { slugify } = require('../../utils/slugify');
const { resolveGroup, invalidateGroupCache } = require('./resolver');

function notFound(slug) {
  const err = new Error(`Company group "${slug}" not found`);
  err.status = 404;
  return err;
}

async function listGroups() {
  return prisma.companyGroup.findMany({ orderBy: { name: 'asc' } });
}

async function getGroup(slug) {
  const group = await prisma.companyGroup.findUnique({ where: { slug } });
  if (!group) throw notFound(slug);
  return group;
}

async function createGroup(data) {
  const slug = data.slug ?? slugify(data.name);
  const created = await prisma.companyGroup.create({
    data: {
      slug,
      name:          data.name,
      description:   data.description,
      filter_type:   data.filter_type,
      filter_config: data.filter_config ?? {},
    },
  });
  invalidateGroupCache(slug); // in case a same-slug group was deleted+recreated within the cache TTL
  return created;
}

async function updateGroup(slug, data) {
  await getGroup(slug); // throws 404 if not found
  const updated = await prisma.companyGroup.update({ where: { slug }, data });
  invalidateGroupCache(slug);
  if (data.slug && data.slug !== slug) invalidateGroupCache(data.slug);
  return updated;
}

async function deleteGroup(slug) {
  await getGroup(slug); // throws 404 if not found
  // CompanyGroupFilter/CompanyGroupMember reference company_group_slug as a
  // plain string (not an FK — see their schema docblocks), so they don't
  // cascade-delete with the group; clean them up explicitly to avoid orphan
  // rows (harmless no-op for 'manual'/'dynamic' groups, which never have any).
  await prisma.$transaction([
    prisma.companyGroupFilter.deleteMany({ where: { company_group_slug: slug } }),
    prisma.companyGroupMember.deleteMany({ where: { company_group_slug: slug } }),
    prisma.companyGroup.delete({ where: { slug } }),
  ]);
  invalidateGroupCache(slug);
}

async function resolveGroupBySlug(slug) {
  const group = await getGroup(slug);
  return resolveGroup(group);
}

module.exports = { listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupBySlug };
