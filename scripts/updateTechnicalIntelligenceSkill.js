'use strict';

/**
 * Writes the live prompt template + output schema for the `technical-intelligence` skill.
 *
 * This script is the source of truth for that DB row. Re-run after editing:
 *   node scripts/updateTechnicalIntelligenceSkill.js
 *
 * NOTE: utils/skillConfig.js caches skill rows for 60s and is NOT invalidated by this
 * script — restart the technicals worker (or wait 60s) before verifying a change.
 *
 * The prompt implements Ajay's framework as specified in:
 *   TECHNICAL_SKILL.md, stock-type-identification.md, framework-tags.md,
 *   ideal-for-identification.md, overview-technicals.md
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');

const promptFilePath = path.resolve(__dirname, '../../Technical_skill_text_v4(1).txt');
const newPromptTemplate = fs.readFileSync(promptFilePath, 'utf8');

const newOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'technical_intelligence',
    strict: false,
    schema: {
      type: 'object',
      required: ['decisionIntelligence', 'scores', 'stockClassification'],
      properties: {

        // Flat by design. Grammar size is driven by the number of DISTINCT object shapes
        // and enum branches, not byte count — a 4.8KB nested schema was rejected as
        // "compiled grammar too large" while this flatter, larger one compiles fine.
        // Techniques used: nested objects flattened into scalars, repeated shapes reused
        // via a single array item definition, and value constraints moved into the prompt.
        decisionIntelligence: {
          type: 'object',
          required: [
            'tag', 'bottomLine', 'lens', 'idealFor', 'timeframe', 'convictionLevel', 'convictionScore',
            'currentRegimeLabel', 'currentRegimeDescription', 'priorityWatchout',
            'actionableInsights', 'whatCanChange', 'indicators', 'levelsToWatch',
            'horizonNote', 'playbook', 'swingScore', 'positionalScore', 'investorScore',
            'structureSummary', 'trendSummary', 'timingSummary', 'relativeStrengthSummary',
          ],
          properties: {
            // Constrained values live in the prompt, not the grammar.
            tag:             { type: 'string' },
            bottomLine:      { type: 'string' },
            lens:            { type: 'string' },   // Growth | Value | Mixed
            idealFor:        { type: 'string' },   // Swing Entry | Positional Add | Investor Entry | Not Suitable
            playbook:        { type: 'string' },   // Exhaustion | Distribution | Breakout | Pullback | Base Building | No Setup
            breakoutQuality: { type: 'string' },   // High Conviction, else omitted
            directionFlag:   { type: 'string' },   // Tier/Band Rising|Falling | Flat, else omitted
            previousScore:   { type: ['integer', 'null'] },
            timeframe:       { type: 'string' },
            convictionLevel: { type: 'string' },   // Very High | High | Medium | Low | Very Low
            convictionScore: { type: 'integer' },

            // Flattened from currentRegime{}
            currentRegimeLabel:       { type: 'string' },
            currentRegimeDescription: { type: 'string' },

            // Flattened from idealForScores{}
            swingScore:      { type: 'integer' },
            positionalScore: { type: 'integer' },
            investorScore:   { type: 'integer' },

            // Flattened from ruleEngine.tabSummaries{}
            structureSummary:        { type: 'string' },
            trendSummary:            { type: 'string' },
            timingSummary:           { type: 'string' },
            relativeStrengthSummary: { type: 'string' },

            priorityWatchout: { type: 'string' },

            // One reusable shape instead of three identical sibling objects.
            actionableInsights: {
              type: 'array',
              items: {
                type: 'object',
                required: ['horizon', 'new_position', 'existing_position', 'watch_for'],
                properties: {
                  horizon:           { type: 'string' },  // swing | positional | investor
                  new_position:      { type: 'string' },
                  existing_position: { type: 'string' },
                  watch_for:         { type: 'string' },
                  idealEntry:        { type: ['integer', 'null'] },
                  stopLoss:          { type: ['integer', 'null'] },
                  target:            { type: ['integer', 'null'] },
                },
              },
            },

            priceAnchors: {
              type: 'object',
              properties: {
                support:    { type: ['number', 'null'] },
                resistance: { type: ['number', 'null'] },
                sma20:      { type: ['number', 'null'] },
                sma50:      { type: ['number', 'null'] },
                sma100:     { type: ['number', 'null'] },
                sma200:     { type: ['number', 'null'] },
              },
            },

            whatCanChange: { type: 'array', items: { type: 'string' } },

            // `id` replaces name+tab; both are derived in code from INDICATOR_META.
            indicators: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'tag', 'sentiment', 'explanation'],
                properties: {
                  id:             { type: 'string' },  // market_structure, capital_participation, ...
                  tag:            { type: 'string' },
                  sentiment:      { type: 'string' },  // positive | transitional | negative
                  explanation:    { type: 'string' },
                  growthWatchout: { type: 'string' },
                  valueWatchout:  { type: 'string' },
                },
              },
            },

            // One object definition instead of immediate/structural/regime siblings.
            levelsToWatch: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type', 'price', 'label'],
                properties: {
                  type:  { type: 'string' },  // immediate | structural | regime
                  price: { type: ['number', 'null'] },
                  label: { type: 'string' },
                },
              },
            },
            horizonNote: { type: 'string' },
          },
        },

        scores: {
          type: 'object',
          required: [
            'structure_wyckoff_sr', 'trend_sma', 'momentum_rsi', 'trend_maturity_adx',
            'leadership_rs', 'capital_flow', 'volatility_bbw', 'final_score', 'grade', 'label',
          ],
          properties: {
            structure_wyckoff_sr: { type: 'integer' },
            trend_sma:            { type: 'integer' },
            momentum_rsi:         { type: 'integer' },
            trend_maturity_adx:   { type: 'integer' },
            leadership_rs:        { type: 'integer' },
            capital_flow:         { type: 'integer' },
            volatility_bbw:       { type: 'integer' },
            final_score:          { type: 'integer' },
            grade:                { type: 'string' },  // A+ | A | B | C | D
            label:                { type: 'string' },  // Leader | Strong | Developing | Weak | Breakdown
            dataGaps:             { type: 'array', items: { type: 'string' } },
          },
        },

        stockClassification: {
          type: 'object',
          required: ['stock_type', 'growth_score', 'value_score', 'classification_note'],
          properties: {
            stock_type:             { type: 'string' },  // Growth | Value | Mixed
            growth_score:           { type: 'integer' },
            value_score:            { type: 'integer' },
            classification_note:    { type: 'string' },
            wyckoff_growth_warning: { type: ['string', 'null'] },
          },
        },

      },
    },
  },
};

/**
 * The provider caps a structured-output schema at 24 OPTIONAL properties
 * ("Schemas contains too many optional parameters (N) ... limit: 24"). Anything not listed
 * in an object's `required` array counts as optional, so a large schema blows the budget
 * immediately — this one had 95.
 *
 * The model is instructed to emit every field regardless, so marking them required costs
 * nothing and takes the optional count to near zero. Only genuinely-absent-able fields stay
 * optional, listed below.
 */
const OPTIONAL_FIELDS = new Set([
  'breakoutQuality',        // null unless a confirmed breakout fires
  'directionFlag',          // null on the first reading for a ticker
  'previousScore',          // null on the first reading for a ticker
  'wyckoff_growth_warning', // only set for Growth + Distribution
  'dataGaps',               // only present when an input was missing
  'phaseRelabelled',        // only set when ambiguity resolution fires
  'priceAnchors',           // optional object
  'idealEntry',             // optional if no valid anchor
  'stopLoss',               // optional if no valid anchor
  'target',                 // optional if no valid anchor
]);

function markRequired(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'object' && node.properties) {
    const keys = Object.keys(node.properties);
    const required = keys.filter((k) => !OPTIONAL_FIELDS.has(k));
    if (required.length) node.required = required;
    keys.forEach((k) => markRequired(node.properties[k]));
  }
  if (node.type === 'array' && node.items) markRequired(node.items);
  return node;
}

markRequired(newOutputSchema.json_schema.schema);

// Report the optional count so a future edit that blows the budget fails loudly here
// rather than as an opaque provider 400 at runtime.
let optionalCount = 0;
(function count(n) {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'object' && n.properties) {
    const req = new Set(n.required ?? []);
    optionalCount += Object.keys(n.properties).filter((k) => !req.has(k)).length;
    Object.values(n.properties).forEach(count);
  }
  if (n.type === 'array' && n.items) count(n.items);
})(newOutputSchema.json_schema.schema);

if (optionalCount > 24) {
  console.error(`ABORT: schema has ${optionalCount} optional properties (provider limit 24).`);
  process.exit(1);
}

prisma.skill.update({
  where: { slug: 'technical-intelligence' },
  data: {
    promptTemplate: newPromptTemplate,
    outputSchema:   newOutputSchema,
    maxTokens:      20000,
  },
})
  .then((s) => {
    console.log('OK — skill updated');
    console.log('  model:              ', s.model);
    console.log('  maxTokens:          ', s.maxTokens);
    console.log('  promptTemplate len: ', s.promptTemplate.length, 'chars');
    console.log('  outputSchema keys:  ', Object.keys(s.outputSchema?.json_schema?.schema?.properties ?? {}));
  })
  .catch((e) => console.error('ERROR:', e))
  .finally(() => prisma.$disconnect());
