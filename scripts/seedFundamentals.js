'use strict';

/**
 * Seed script: creates the Fundamentals Intelligence Skill, Plugin, and PluginSkill records.
 *
 * The promptTemplate and outputSchema live here in the DB — not in any backend file.
 * Edit them here and re-run to update without a code deploy.
 *
 * Usage:  node scripts/seedFundamentals.js
 */

const prisma = require('../config/prisma');

// ─── Prompt template ─────────────────────────────────────────────────────────
// {{DATA_BLOCK}} is replaced at runtime by fundamentalsIntelligencePrompt()

const PROMPT_TEMPLATE = `You are a senior fundamental equity analyst covering Indian listed companies. Based on the structured financial data below, generate a Fundamentals Intelligence summary in strict JSON.

{{DATA_BLOCK}}

---
Respond ONLY with a valid JSON object matching this exact schema (no markdown fences, no preamble):
{
  "tag": "<2-5 words quality tag, e.g. 'Quality Compounder', 'Turnaround Candidate', 'Value Trap Risk', 'High Growth Premium', 'Debt-Heavy Laggard'>",
  "fundamentalGrade": "<A+ | A | B+ | B | C | D>",
  "actionBias": "<max 25 words, one crisp actionable sentence on what an investor should do now and why>",
  "actionableInsight": {
    "action": "<Accumulate | Buy | Hold | Reduce | Avoid>",
    "rationale": "<max 20 words, single sentence justifying the action>",
    "existingHolderAction": "<max 15 words, guidance for holders>",
    "reEvaluateCondition": "<max 20 words, what would change the view>"
  },
  "signals": {
    "growth": "<Accelerating | Stable | Decelerating | Negative | Insufficient Data>",
    "profitability": "<Expanding | Stable | Compressing | Loss-Making | Insufficient Data>",
    "balanceSheet": "<Strong | Adequate | Leveraged | Stressed | Insufficient Data>",
    "cashConversion": "<Excellent | Good | Moderate | Poor | Insufficient Data>",
    "industry": "<Growing | Stable | Declining | Insufficient Data>",
    "valuation": "<Cheap | Fair | Expensive | Overvalued | Insufficient Data>"
  },
  "swot": {
    "strengths": ["<max 15 words each, 2-4 bullet points>"],
    "weaknesses": ["<max 15 words each, 2-4 bullet points>"],
    "opportunities": ["<max 15 words each, 2-4 bullet points>"],
    "threats": ["<max 15 words each, 2-4 bullet points>"]
  },
  "keyMetricsSummary": [
    { "name": "Revenue Growth", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "Profit Growth", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "ROE", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "Operating Margin", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "Debt-to-Equity", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "Valuation (P/E or P/B)", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" },
    { "name": "Cash from Operations", "value": "<string>", "assessment": "<Positive | Neutral | Negative>", "comment": "<max 12 words>" }
  ],
  "whatCanChange": ["<max 15 words each, 3-5 fundamental catalysts that could shift the view>"],
  "riskAlerts": ["<3-5 words>", "<3-5 words>"],
  "convictionLevel": "<Low | Medium | High>"
}

Rules:
- tag: 2-5 words that capture the fundamental character of this business (e.g. "Quality Compounder", "Turnaround Candidate")
- fundamentalGrade: A+ for top-tier quality compounders; D for deteriorating/highly stressed businesses
- actionBias: max 25 words, direct imperative tone, must reference at least one key metric
- actionableInsight.action: "Accumulate" for strong quality at fair price; "Buy" for clear value; "Hold" for steady; "Reduce" for deteriorating; "Avoid" for stressed
- signals: each field must be one of the listed enum values — derive from the data provided
- signals.industry: the trajectory of the sector the company operates in, NOT the company itself — use the COMPANY IDENTITY block's industry group / basic industry / main product as the subject. "Growing" for structural sector tailwinds and expanding end-demand; "Stable" for mature, cyclical or flat demand; "Declining" for structural headwinds, shrinking demand or disruption risk; "Insufficient Data" only when the COMPANY IDENTITY block gives no industry
- swot.strengths: 2-4 bullets each max 15 words; focus on durable competitive advantages observable in the numbers
- swot.weaknesses: 2-4 bullets; operational or financial vulnerabilities visible in the data
- swot.opportunities: 2-4 bullets; sector tailwinds, market expansion, margin improvement scope
- swot.threats: 2-4 bullets; macro risks, competitive pressure, balance sheet risks
- keyMetricsSummary: always exactly 7 objects in the order above; use actual numbers from the data; IMPORTANT for growth metrics: use the BEST AVAILABLE period — if 3Y CAGR is available use it, else use 5Y or 10Y CAGR, else use YoY growth labeled as "YoY (FYxx→FYxx)"; for ROE use best available average period (3Y > 5Y > latest single year); for valuation use P/E if available, else P/B with a note; never output "N/A" if any growth figure exists in the data block
- whatCanChange: 3-5 specific catalysts (e.g. "Debt reduction below 0.5x improves balance sheet signal")
- riskAlerts: 3-5 items max, each exactly 3-5 words, noun phrases only
- convictionLevel: High if grade is A+ or A with clear signal alignment; Medium for B/mixed; Low for C/D or data gaps
- Return pure JSON only`;

// ─── Output schema (used for validation / display — not enforced by LLM call) ─

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['tag', 'fundamentalGrade', 'actionBias', 'actionableInsight', 'signals', 'swot', 'keyMetricsSummary', 'whatCanChange', 'riskAlerts', 'convictionLevel'],
  properties: {
    tag:               { type: 'string' },
    fundamentalGrade:  { type: 'string', enum: ['A+', 'A', 'B+', 'B', 'C', 'D'] },
    actionBias:        { type: 'string' },
    actionableInsight: {
      type: 'object',
      properties: {
        action:               { type: 'string', enum: ['Accumulate', 'Buy', 'Hold', 'Reduce', 'Avoid'] },
        rationale:            { type: 'string' },
        existingHolderAction: { type: 'string' },
        reEvaluateCondition:  { type: 'string' },
      },
    },
    signals: {
      type: 'object',
      // getFinancials reads these keys to decide whether a cached ai_insights
      // row still matches the promised shape — keep them in sync with the
      // prompt's signals block above.
      required: ['growth', 'profitability', 'balanceSheet', 'cashConversion', 'industry', 'valuation'],
      properties: {
        growth:         { type: 'string' },
        profitability:  { type: 'string' },
        balanceSheet:   { type: 'string' },
        cashConversion: { type: 'string' },
        industry:       { type: 'string', enum: ['Growing', 'Stable', 'Declining', 'Insufficient Data'] },
        valuation:      { type: 'string' },
      },
    },
    swot: {
      type: 'object',
      properties: {
        strengths:    { type: 'array', items: { type: 'string' } },
        weaknesses:   { type: 'array', items: { type: 'string' } },
        opportunities: { type: 'array', items: { type: 'string' } },
        threats:      { type: 'array', items: { type: 'string' } },
      },
    },
    keyMetricsSummary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:       { type: 'string' },
          value:      { type: 'string' },
          assessment: { type: 'string', enum: ['Positive', 'Neutral', 'Negative'] },
          comment:    { type: 'string' },
        },
      },
    },
    whatCanChange:  { type: 'array', items: { type: 'string' } },
    riskAlerts:     { type: 'array', items: { type: 'string' } },
    convictionLevel: { type: 'string', enum: ['Low', 'Medium', 'High'] },
  },
};

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  // 1. Upsert the Skill
  const skill = await prisma.skill.upsert({
    where:  { slug: 'fundamentals-intelligence' },
    update: {
      promptTemplate: PROMPT_TEMPLATE,
      outputSchema:   OUTPUT_SCHEMA,
    },
    create: {
      name:           'Fundamentals Intelligence',
      slug:           'fundamentals-intelligence',
      description:    'Generates actionable fundamental analysis insight with signals breakdown, SWOT, and graded assessment from financial data.',
      promptKey:      'fundamentalsIntelligencePrompt',
      promptTemplate: PROMPT_TEMPLATE,
      outputSchema:   OUTPUT_SCHEMA,
      model:          'anthropic/claude-haiku-4.5',
      maxTokens:      16000,
      isActive:       true,
    },
  });
  console.log(`✓ Skill upserted: ${skill.name} (${skill.slug})`);

  // 2. Upsert the Plugin
  const plugin = await prisma.plugin.upsert({
    where:  { slug: 'fundamentals' },
    update: {},
    create: {
      name:        'Fundamentals',
      slug:        'fundamentals',
      description: 'Fundamental analysis pipeline — generates structured intelligence from financial statements.',
      category:    'fundamentals',
      isActive:    true,
    },
  });
  console.log(`✓ Plugin upserted: ${plugin.name} (${plugin.slug})`);

  // 3. Upsert the PluginSkill link
  const existing = await prisma.pluginSkill.findFirst({
    where: { pluginId: plugin.id, skillId: skill.id },
  });

  if (!existing) {
    await prisma.pluginSkill.create({
      data: { pluginId: plugin.id, skillId: skill.id, order: 1 },
    });
    console.log(`✓ PluginSkill linked: ${plugin.slug} → ${skill.slug} (order 1)`);
  } else {
    console.log(`  PluginSkill already exists: ${plugin.slug} → ${skill.slug}`);
  }

  console.log('\nFundamentals seed complete.');
}

seed()
  .catch((err) => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
