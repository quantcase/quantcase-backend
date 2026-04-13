'use strict';

const prisma = require('../config/prisma');
const { slugify } = require('../utils/slugify');

const PLUGIN_INCLUDE = {
  pluginSkills: {
    orderBy: { order: 'asc' },
    include: { skill: true },
  },
};

function notFound(id) {
  const err = new Error(`Plugin "${id}" not found`);
  err.status = 404;
  return err;
}

async function listPlugins() {
  return prisma.plugin.findMany({
    orderBy: { name: 'asc' },
    include: PLUGIN_INCLUDE,
  });
}

async function getPlugin(id) {
  const plugin = await prisma.plugin.findUnique({ where: { id }, include: PLUGIN_INCLUDE });
  if (!plugin) throw notFound(id);
  return plugin;
}

async function createPlugin(data) {
  const slug = data.slug ?? slugify(data.name);
  return prisma.plugin.create({ data: { ...data, slug }, include: PLUGIN_INCLUDE });
}

async function updatePlugin(id, data) {
  await getPlugin(id); // throws 404 if not found
  // If name is being updated and slug isn't explicitly provided, regenerate slug
  if (data.name && data.slug === undefined) data.slug = slugify(data.name);
  return prisma.plugin.update({ where: { id }, data, include: PLUGIN_INCLUDE });
}

async function deletePlugin(id) {
  await getPlugin(id); // throws 404 if not found
  // PluginSkill rows are cascade-deleted by Prisma via onDelete: Cascade
  return prisma.plugin.delete({ where: { id } });
}

async function listPluginSkills(pluginId) {
  await getPlugin(pluginId);
  return prisma.pluginSkill.findMany({
    where:   { pluginId },
    orderBy: { order: 'asc' },
    include: { skill: true },
  });
}

async function addSkillToPlugin(pluginId, skillId, order) {
  await getPlugin(pluginId);
  // Verify skill exists
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) {
    const err = new Error(`Skill "${skillId}" not found`);
    err.status = 404;
    throw err;
  }
  return prisma.pluginSkill.upsert({
    where:   { pluginId_skillId: { pluginId, skillId } },
    update:  { order },
    create:  { pluginId, skillId, order },
    include: { skill: true },
  });
}

async function removeSkillFromPlugin(pluginId, skillId) {
  await getPlugin(pluginId);
  const ps = await prisma.pluginSkill.findUnique({
    where: { pluginId_skillId: { pluginId, skillId } },
  });
  if (!ps) {
    const err = new Error(`Skill "${skillId}" is not part of plugin "${pluginId}"`);
    err.status = 404;
    throw err;
  }
  return prisma.pluginSkill.delete({ where: { pluginId_skillId: { pluginId, skillId } } });
}

/**
 * Reorder all skills in a plugin.
 * orderedSkillIds: array of skillId strings in the desired order (1-based position = index + 1).
 */
async function reorderPluginSkills(pluginId, orderedSkillIds) {
  await getPlugin(pluginId);
  return prisma.$transaction(
    orderedSkillIds.map((skillId, idx) =>
      prisma.pluginSkill.update({
        where: { pluginId_skillId: { pluginId, skillId } },
        data:  { order: idx + 1 },
      })
    )
  );
}

module.exports = {
  listPlugins,
  getPlugin,
  createPlugin,
  updatePlugin,
  deletePlugin,
  listPluginSkills,
  addSkillToPlugin,
  removeSkillFromPlugin,
  reorderPluginSkills,
};
