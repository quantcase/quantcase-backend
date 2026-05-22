'use strict';

const prisma = require('../config/prisma');

const CACHE_TTL_MS = 60_000; // 1 minute
const cache = new Map(); // slug → { value, expiresAt }

/**
 * Load a skill's runtime config from the database by skill slug.
 * Results are cached in-process for 1 minute to avoid a DB hit per job.
 *
 * @param {string} skillSlug  e.g. "summarization", "ofactor-industry"
 * @returns {{
 *   model: string,
 *   maxTokens: number,
 *   outputSchema: object|undefined,
 *   promptKey: string,
 *   promptTemplate: string|null,
 *   defaultInstructions: string|null,
 *   updatedAt: Date,
 * }}
 */
async function loadSkillConfig(skillSlug) {
  const cached = cache.get(skillSlug);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const skill = await prisma.skill.findUnique({ where: { slug: skillSlug } });
  if (!skill)          throw new Error(`Skill "${skillSlug}" not found in DB`);
  if (!skill.isActive) throw new Error(`Skill "${skillSlug}" is inactive`);
  const value = {
    model:               skill.model,
    maxTokens:           skill.maxTokens,
    outputSchema:        skill.outputSchema ?? undefined,
    promptKey:           skill.promptKey,
    promptTemplate:      skill.promptTemplate      ?? null,
    defaultInstructions: skill.defaultInstructions ?? null,
    updatedAt:           skill.updatedAt,
  };
  cache.set(skillSlug, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = { loadSkillConfig };
