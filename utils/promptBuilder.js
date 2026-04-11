'use strict';

/**
 * Merge a runtime data block into a DB-stored prompt template.
 *
 * The template uses two placeholder tokens:
 *   {{DATA_BLOCK}}           — replaced with the runtime-assembled context string
 *   {{DEFAULT_INSTRUCTIONS}} — replaced with the skill's defaultInstructions from DB
 *                              (falls back to the inline fallback string if provided)
 *
 * If no template is stored in DB (null), the function returns the dataBlock directly
 * so workers that haven't been migrated yet continue to work unchanged.
 *
 * @param {string}      dataBlock            - Runtime-assembled data context string
 * @param {string|null} template             - promptTemplate from DB (may be null)
 * @param {string|null} defaultInstructions  - defaultInstructions from DB (may be null)
 * @param {string}      [fallbackInstructions=''] - Inline fallback if DB value is null
 * @returns {string}
 */
function buildPrompt(dataBlock, template, defaultInstructions, fallbackInstructions = '') {
  if (!template) return dataBlock;

  const instructions = defaultInstructions ?? fallbackInstructions;
  return template
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', instructions);
}

module.exports = { buildPrompt };
