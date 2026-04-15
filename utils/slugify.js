'use strict';

/**
 * Convert any string to a URL-safe kebab-case slug.
 * e.g. "Transcript Extractor"  → "transcript-extractor"
 *      "ofactorIndustryPrompt" → "ofactor-industry-prompt"
 */
function slugify(str) {
  return str
    // Insert hyphen before uppercase letters (camelCase → kebab)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    // Replace spaces, underscores, dots with hyphens
    .replace(/[\s_\.]+/g, '-')
    // Strip non-alphanumeric except hyphens
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()
    // Collapse multiple hyphens
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { slugify };
