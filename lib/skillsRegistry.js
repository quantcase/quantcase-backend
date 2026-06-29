'use strict';

const { transcriptExtractorPrompt }   = require('../prompts/transcript_call');
const { transcriptExtractorPromptV2 } = require('../prompts/transcript_call_v2');
const { quarterlyEarningsPrompt }    = require('../prompts/quarterly_earnings');
const { suggestionGenerationPrompt } = require('../prompts/wealthos/suggestion_generation');
const { messageGenerationPrompt }    = require('../prompts/wealthos/message_generation');
const {
  drhpGeneralRiskPrompt,
  drhpCompanyOverviewPrompt,
  drhpFinancialsPrompt,
  drhpLegalOfferPrompt,
  drhpIntelligencePrompt,
} = require('../prompts/drhp_section_prompts');
const { fundamentalsIntelligencePrompt } = require('../prompts/fundamentals_intelligence');
const { aiInsightSynthesisPrompt } = require('../prompts/ai_insight_synthesis');

/**
 * Maps promptKey (stored in DB on each Skill) → the actual prompt builder function.
 * Prompts are dynamic JS functions that take context arguments — they cannot be
 * stored as raw text. Skills reference them by key; workers resolve at runtime.
 */
const SKILLS_REGISTRY = {
  transcriptExtractorPrompt,
  transcriptExtractorPromptV2,
  quarterlyEarningsPrompt,
  wealthosSuggestionPrompt:       suggestionGenerationPrompt,
  wealthosMessagePrompt:          messageGenerationPrompt,
  drhpGeneralRiskPrompt,
  drhpCompanyOverviewPrompt,
  drhpFinancialsPrompt,
  drhpLegalOfferPrompt,
  drhpIntelligencePrompt,
  fundamentalsIntelligencePrompt,
  aiInsightSynthesisPrompt,
};

/**
 * Resolve a prompt function by its key. Throws if the key is unknown.
 * @param {string} promptKey
 * @returns {Function}
 */
function getPromptFn(promptKey) {
  const fn = SKILLS_REGISTRY[promptKey];
  if (!fn) throw new Error(`skillsRegistry: unknown promptKey "${promptKey}"`);
  return fn;
}

module.exports = { SKILLS_REGISTRY, getPromptFn };
