'use strict';

const { transcriptExtractorPrompt }  = require('../prompts/transcript_call');
const { quarterlyEarningsPrompt }    = require('../prompts/quarterly_earnings');
const { dealAnalysisPrompt }         = require('../prompts/deal_analysis');
const { industryPrompt }             = require('../prompts/of-prompts/industry-prompt');
const { competitionPrompt }          = require('../prompts/of-prompts/competition-prompt');
const { financialStrengthPrompt }    = require('../prompts/of-prompts/financial-strength-prompt');
const { customerTractionPrompt }     = require('../prompts/of-prompts/customer-traction-prompt');
const { finalTakeawaysPrompt }       = require('../prompts/of-prompts/final-takeaways-prompt');
const { suggestionGenerationPrompt } = require('../prompts/wealthos/suggestion_generation');
const { messageGenerationPrompt }    = require('../prompts/wealthos/message_generation');

/**
 * Maps promptKey (stored in DB on each Skill) → the actual prompt builder function.
 * Prompts are dynamic JS functions that take context arguments — they cannot be
 * stored as raw text. Skills reference them by key; workers resolve at runtime.
 */
const SKILLS_REGISTRY = {
  transcriptExtractorPrompt,
  quarterlyEarningsPrompt,
  dealAnalysisPrompt,
  ofactorIndustryPrompt:          industryPrompt,
  ofactorCompetitionPrompt:       competitionPrompt,
  ofactorFinancialStrengthPrompt: financialStrengthPrompt,
  ofactorCustomerTractionPrompt:  customerTractionPrompt,
  ofactorFinalTakeawaysPrompt:    finalTakeawaysPrompt,
  wealthosSuggestionPrompt:       suggestionGenerationPrompt,
  wealthosMessagePrompt:          messageGenerationPrompt,
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
