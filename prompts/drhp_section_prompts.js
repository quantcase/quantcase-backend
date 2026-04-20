'use strict';

/**
 * Section-specific DRHP prompt builders.
 *
 * All prompt content (instructions, output schema) lives in the DB on each Skill row:
 *   - defaultInstructions: the analyst persona + section-specific guidance
 *   - promptTemplate:      full prompt with {{DEFAULT_INSTRUCTIONS}}, {{SECTION_TITLE}},
 *                          {{SECTION_TEXT}} placeholders
 *
 * These functions are thin wrappers: they receive the DB-stored template (passed in by
 * the service layer via loadSkillConfig) and substitute the runtime values.
 * The hardcoded fallbacks here exist only so the code doesn't crash if a DB row is
 * missing its template — they should never be reached in production.
 *
 * Signature: (sectionText: string, sectionTitle: string, template?: string|null) => string
 */

function renderTemplate(template, sectionText, sectionTitle, defaultInstructions = '') {
  return template
    .replace('{{DEFAULT_INSTRUCTIONS}}', defaultInstructions)
    .replace('{{SECTION_TITLE}}', sectionTitle)
    .replace('{{SECTION_TEXT}}', sectionText);
}

// The service passes promptTemplate from the DB as the third argument.
// defaultInstructions is the fourth argument — the service currently only passes three,
// so we need to load it separately. Since loadSkillConfigCached already returns
// defaultInstructions, we extend the call signature to accept it.

function drhpGeneralRiskPrompt(sectionText, sectionTitle, template = null, defaultInstructions = '') {
  if (!template) throw new Error('drhpGeneralRiskPrompt: promptTemplate not found in DB');
  return renderTemplate(template, sectionText, sectionTitle, defaultInstructions);
}

function drhpCompanyOverviewPrompt(sectionText, sectionTitle, template = null, defaultInstructions = '') {
  if (!template) throw new Error('drhpCompanyOverviewPrompt: promptTemplate not found in DB');
  return renderTemplate(template, sectionText, sectionTitle, defaultInstructions);
}

function drhpFinancialsPrompt(sectionText, sectionTitle, template = null, defaultInstructions = '') {
  if (!template) throw new Error('drhpFinancialsPrompt: promptTemplate not found in DB');
  return renderTemplate(template, sectionText, sectionTitle, defaultInstructions);
}

function drhpLegalOfferPrompt(sectionText, sectionTitle, template = null, defaultInstructions = '') {
  if (!template) throw new Error('drhpLegalOfferPrompt: promptTemplate not found in DB');
  return renderTemplate(template, sectionText, sectionTitle, defaultInstructions);
}

module.exports = {
  drhpGeneralRiskPrompt,
  drhpCompanyOverviewPrompt,
  drhpFinancialsPrompt,
  drhpLegalOfferPrompt,
};
