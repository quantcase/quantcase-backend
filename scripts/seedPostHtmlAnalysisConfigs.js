'use strict';

/**
 * Seed script: create the initial PostHtmlAnalysisConfig rows for the
 * post-HTML-analysis pipeline (L3: management/opportunity/deal, L4: summary).
 * Prompts/schemas here are starting points — edit via the DB/admin tooling
 * once real prompt requirements are finalised.
 *
 * Usage: node scripts/seedPostHtmlAnalysisConfigs.js
 */

const prisma = require('../config/prisma');

const L3_VERDICT_SCHEMA = {
  type: 'object',
  required: ['score', 'verdict', 'headline', 'summary', 'key_points'],
  properties: {
    score:   { type: 'integer', description: 'Overall score 0-100 for this dimension.' },
    verdict: { type: 'string', enum: ['STRONG', 'MODERATE', 'CAUTIOUS', 'WEAK'] },
    headline: { type: 'string', description: '≤8 words — punchy verdict headline.' },
    summary:  { type: 'string', description: '2-3 sentences summarising the analysis.' },
    key_points: {
      type: 'array',
      description: '3-5 bullet points, the most important findings.',
      items: { type: 'string' },
    },
  },
};

const L4_SUMMARY_SCHEMA = {
  type: 'object',
  required: ['score', 'conviction', 'headline', 'summary', 'dimensions'],
  properties: {
    score:      { type: 'integer', description: 'Weighted composite score 0-100 across management/opportunity/deal.' },
    conviction: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    headline:   { type: 'string', description: '≤8 words — top-level investment verdict.' },
    summary:    { type: 'string', description: '2-3 sentences synthesising all three L3 dimensions.' },
    dimensions: {
      type: 'array',
      description: 'One entry per L3 type (management/opportunity/deal).',
      items: {
        type: 'object',
        required: ['type', 'score', 'takeaway'],
        properties: {
          type:     { type: 'string', enum: ['management', 'opportunity', 'deal'] },
          score:    { type: 'integer' },
          takeaway: { type: 'string', description: '≤15 words.' },
        },
      },
    },
  },
};

const L3_CONFIGS = [
  {
    layer_id: 'l3',
    type: 'management',
    name: 'L3 — Management',
    prompt: 'You are a senior financial analyst assessing management quality and execution credibility for this company, based on the guidance-credibility, disclosure-honesty, capital-allocation, and promoter-activity analyses below. Synthesise them into a single management verdict.',
    output_schema: L3_VERDICT_SCHEMA,
  },
  {
    layer_id: 'l3',
    type: 'opportunity',
    name: 'L3 — Opportunity',
    prompt: 'You are a senior financial analyst assessing business quality and opportunity for this company, based on the industry-analysis, competition, financial-strength, and customer-distribution analyses below. Synthesise them into a single opportunity verdict.',
    output_schema: L3_VERDICT_SCHEMA,
  },
  {
    layer_id: 'l3',
    type: 'deal',
    name: 'L3 — Deal',
    prompt: 'You are a senior financial analyst assessing whether to buy/hold/avoid this stock now, based on the earnings-forecast, earning-quality, pe-rerating-potential, and target-price-matrix analyses below. Synthesise them into a single deal verdict.',
    output_schema: L3_VERDICT_SCHEMA,
  },
];

const L4_CONFIGS = [
  {
    layer_id: 'l4',
    type: 'summary',
    name: 'L4 — Top-level Summary',
    prompt: 'You are a senior financial analyst producing a top-level investment summary for this company, based on the management, opportunity, and deal verdicts below (each already synthesised from underlying lens analyses). Weigh all three and produce one overall verdict.',
    output_schema: L4_SUMMARY_SCHEMA,
  },
];

async function main() {
  let created = 0;
  let updated = 0;

  for (const cfg of [...L3_CONFIGS, ...L4_CONFIGS]) {
    const existing = await prisma.postHtmlAnalysisConfig.findUnique({
      where: { layer_id_type: { layer_id: cfg.layer_id, type: cfg.type } },
    });

    if (existing) {
      await prisma.postHtmlAnalysisConfig.update({
        where: { id: existing.id },
        data: { name: cfg.name, prompt: cfg.prompt, output_schema: cfg.output_schema },
      });
      console.log(`✓ Updated config: ${cfg.layer_id}/${cfg.type}`);
      updated++;
    } else {
      await prisma.postHtmlAnalysisConfig.create({ data: cfg });
      console.log(`✓ Created config: ${cfg.layer_id}/${cfg.type}`);
      created++;
    }
  }

  console.log(`\nDone. ${created} created, ${updated} updated.`);
}

main()
  .catch(err => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
