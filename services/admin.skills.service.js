'use strict';

const prisma = require('../config/prisma');
const { SKILLS_REGISTRY } = require('../lib/skillsRegistry');
const { slugify } = require('../utils/slugify');
const { computePromptVersion } = require('../utils/sourceHash');
const { invalidateByPromptVersion } = require('./db/signals.db');
const { markLensesStale } = require('./lensComposer');

const VALID_PROMPT_KEYS = new Set(Object.keys(SKILLS_REGISTRY));

function notFound(skillId) {
  const err = new Error(`Skill "${skillId}" not found`);
  err.status = 404;
  return err;
}

async function listSkills() {
  return prisma.skill.findMany({
    orderBy: { name: 'asc' },
    include: { pluginSkills: { include: { plugin: { select: { id: true, name: true, category: true } } } } },
  });
}

async function getSkill(id) {
  const skill = await prisma.skill.findUnique({
    where:   { id },
    include: { pluginSkills: { include: { plugin: { select: { id: true, name: true, category: true } } } } },
  });
  if (!skill) throw notFound(id);
  return skill;
}

async function createSkill(data) {
  if (!VALID_PROMPT_KEYS.has(data.promptKey)) {
    const err = new Error(`promptKey "${data.promptKey}" is not registered in skillsRegistry. Valid keys: ${[...VALID_PROMPT_KEYS].join(', ')}`);
    err.status = 400;
    throw err;
  }
  const slug = data.slug ?? slugify(data.name);
  return prisma.skill.create({ data: { ...data, slug } });
}

async function updateSkill(id, data) {
  const existing = await getSkill(id); // throws 404 if not found
  if (data.promptKey && !VALID_PROMPT_KEYS.has(data.promptKey)) {
    const err = new Error(`promptKey "${data.promptKey}" is not registered in skillsRegistry`);
    err.status = 400;
    throw err;
  }
  // If name is being updated and slug isn't explicitly provided, regenerate slug
  if (data.name && data.slug === undefined) data.slug = slugify(data.name);

  const updated = await prisma.skill.update({ where: { id }, data });

  // When promptTemplate changes, invalidate Signal Store signals and mark lens scores stale
  if (process.env.ENABLE_SIGNAL_STORE === 'true' && data.promptTemplate !== undefined) {
    const skillSlug = existing.slug ?? existing.name;
    const oldPromptV = computePromptVersion(skillSlug, existing.updatedAt);
    const invalidated = await invalidateByPromptVersion(oldPromptV);
    if (invalidated > 0) {
      console.log(`[admin.skills] Invalidated ${invalidated} signals for promptV="${oldPromptV}"`);
      // Find all affected callIds and mark their lens scores stale
      const affectedSignals = await prisma.extractedSignal.findMany({
        where:  { prompt_v: oldPromptV },
        select: { call_id: true },
        distinct: ['call_id'],
      });
      await Promise.all(affectedSignals.map(s => markLensesStale(s.call_id)));
      console.log(`[admin.skills] Marked lenses stale for ${affectedSignals.length} calls`);
    }
  }

  return updated;
}

async function deleteSkill(id) {
  await getSkill(id); // throws 404 if not found
  // Cascade is handled by PluginSkill onDelete: Cascade in schema
  return prisma.skill.delete({ where: { id } });
}

module.exports = { listSkills, getSkill, createSkill, updateSkill, deleteSkill };
