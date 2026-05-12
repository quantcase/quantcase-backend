'use strict';

const { createHash } = require('crypto');

/**
 * Compute a deterministic SHA-256 hash of one or more source document strings.
 * Used to gate L1 LLM re-runs: if the hash matches existing ExtractedSignal rows,
 * the extraction is skipped.
 *
 * @param {...string} parts  Text strings (e.g. transcriptText, pptText)
 * @returns {string}  Hex SHA-256 hash
 */
function computeSourceHash(...parts) {
  const combined = parts
    .filter(p => p && typeof p === 'string')
    .join('|||SEPARATOR|||');
  return createHash('sha256').update(combined, 'utf8').digest('hex');
}

/**
 * Compute a deterministic version string for a skill config.
 * Encodes both the skill slug and the last time its prompt template was edited.
 * When a Skill's promptTemplate changes, updatedAt advances, invalidating old signals.
 *
 * @param {string} skillSlug
 * @param {Date|string} skillUpdatedAt
 * @returns {string}  e.g. "summarization@2026-05-10T10:00:00.000Z"
 */
function computePromptVersion(skillSlug, skillUpdatedAt) {
  const ts = skillUpdatedAt instanceof Date
    ? skillUpdatedAt.toISOString()
    : String(skillUpdatedAt);
  return `${skillSlug}@${ts}`;
}

module.exports = { computeSourceHash, computePromptVersion };
