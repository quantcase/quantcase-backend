'use strict';

/**
 * Build the LLM prompt for a post-HTML-analysis (L3 or L4) job.
 * The DB-stored config prompt is the analysis-specific instructions; this
 * just appends the stripped data block the LLM should work from.
 *
 * @param {string} configPrompt  PostHtmlAnalysisConfig.prompt
 * @param {string} dataBlock     Stripped/labeled HTML (L3) or L3 results (L4)
 * @returns {string}
 */
function postHtmlAnalysisPrompt(configPrompt, dataBlock) {
  return `${configPrompt}\n\nSOURCE DATA:\n${dataBlock}\n\nWork ONLY from the data above — do not invent facts. Return a single valid JSON object matching the required schema.`;
}

module.exports = { postHtmlAnalysisPrompt };
