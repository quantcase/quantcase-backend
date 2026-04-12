'use strict';

const prisma = require('../config/prisma');

/**
 * Load a skill's runtime config from the database by skill name.
 * Called by workers at the start of each job to get model, token limit,
 * output schema, and prompt content without hardcoding them in worker files.
 *
 * @param {string} skillName  e.g. "summarization", "ofactor_industry"
 * @returns {{
 *   model: string,
 *   maxTokens: number,
 *   outputSchema: object|undefined,
 *   promptKey: string,
 *   promptTemplate: string|null,
 *   defaultInstructions: string|null,
 * }}
 */
async function loadSkillConfig(skillName) {
  const skill = await prisma.skill.findUnique({ where: { name: skillName } });
  if (!skill)          throw new Error(`Skill "${skillName}" not found in DB`);
  if (!skill.isActive) throw new Error(`Skill "${skillName}" is inactive`);
  return {
    model:               skill.model,
    maxTokens:           skill.maxTokens,
    outputSchema:        skill.outputSchema ?? undefined,
    promptKey:           skill.promptKey,
    promptTemplate:      skill.promptTemplate      ?? null,
    defaultInstructions: skill.defaultInstructions ?? null,
  };
}

module.exports = { loadSkillConfig };
