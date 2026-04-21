'use strict';

// promptTemplate and outputSchema live entirely in the DB (Skill slug: "deal-intelligence").
// This file only injects the deal scenarios data block into the DB-sourced template.

/**
 * Serialize the raw deal analysis result (scenario_framework, risk_reward_summary, etc.)
 * plus the financial inputs as a JSON data block, then inject into the DB template.
 *
 * @param {object}  dealResult      - Raw DealResult.result from the deal-analysis skill
 * @param {object}  dealInputs      - DealResult.inputs { cmp, stockEps, stockPe, industryEps, industryPe }
 * @param {Array}   recentSummaries - Recent earnings call summaries (governance signals, tone, confidence)
 * @param {string}  dbTemplate      - DB promptTemplate (Skill slug: "deal-intelligence")
 * @returns {string}
 */
function dealIntelligencePrompt(dealResult, dealInputs, recentSummaries = [], dbTemplate = null) {
  if (!dbTemplate) throw new Error('[dealIntelligencePrompt] template must come from DB — Skill slug: "deal-intelligence"');

  const mgmtSignals = recentSummaries.flatMap(s => s.governanceSignals ?? []).slice(0, 8);
  const tone        = recentSummaries.at(-1)?.tone       ?? null;
  const confidence  = recentSummaries.at(-1)?.confidence ?? null;

  const dataBlock = JSON.stringify({
    deal_analysis:    dealResult,
    financial_inputs: dealInputs,
    management_context: {
      governance_signals: mgmtSignals,
      tone,
      confidence,
    },
  }, null, 2);

  return dbTemplate.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { dealIntelligencePrompt };
