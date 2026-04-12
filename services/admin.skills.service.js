'use strict';

const prisma = require('../config/prisma');
const { SKILLS_REGISTRY } = require('../lib/skillsRegistry');

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
  return prisma.skill.create({ data });
}

async function updateSkill(id, data) {
  await getSkill(id); // throws 404 if not found
  if (data.promptKey && !VALID_PROMPT_KEYS.has(data.promptKey)) {
    const err = new Error(`promptKey "${data.promptKey}" is not registered in skillsRegistry`);
    err.status = 400;
    throw err;
  }
  return prisma.skill.update({ where: { id }, data });
}

async function deleteSkill(id) {
  await getSkill(id); // throws 404 if not found
  // Cascade is handled by PluginSkill onDelete: Cascade in schema
  return prisma.skill.delete({ where: { id } });
}

module.exports = { listSkills, getSkill, createSkill, updateSkill, deleteSkill };
