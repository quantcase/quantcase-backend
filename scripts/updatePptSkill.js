'use strict';

/**
 * Creates or updates the summarization-v2-ppt skill in the DB.
 *
 * Uses the SAME output schema as summarization-v2 so PPT signals land in the
 * same transcript_signals_v2 table with an identical shape.
 *
 * The only schema difference: source_context enum is the 12 PPT category slugs
 * instead of the 3 transcript section labels — but we keep strict: false so the
 * LLM isn't rejected by the schema validator (Claude doesn't enforce enum on
 * source_context strictly).
 *
 * Run: node scripts/updatePptSkill.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { PROMPT_TEMPLATE_PPT } = require('../prompts/ppt_call_v2');

const SKILL_SLUG = 'summarization-v2-ppt';

// Reuse the same output schema shape as summarization-v2.
// source_context enum is relaxed (string) to accommodate the 12 PPT categories.
const OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'summarization_v2_ppt',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['signals', 'new_kpis'],
      properties: {
        signals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'signal_id', 'source_statement_id', 'source_context', 'signal_type',
              'impact', 'severity', 'statement',
              'category', 'metric', 'topic', 'measures', 'details',
            ],
            properties: {
              signal_id:           { type: 'string' },
              source_statement_id: { type: 'string' },
              source_context: {
                type: 'string',
                // 12 PPT category slugs — relaxed (no strict enum) so schema
                // validation doesn't reject valid PPT-sourced signals
                enum: [
                  'financial_actual', 'capex_actual', 'kpi_actual',
                  'customer_concentration', 'distribution_channels',
                  'product_technology', 'competitive_landscape',
                  'disclosure_quality', 'industry_signals',
                  'capital_allocation', 'earnings_quality', 'future_target',
                ],
              },
              signal_type: {
                type: 'string',
                enum: [
                  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
                  'distribution_customer', 'growth_forecast', 'earnings_quality', 'kpi',
                  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
                  'competitive_position', 'milestone', 'ongoing',
                ],
              },
              impact:           { type: 'string', enum: ['high', 'medium', 'low'] },
              severity:         { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
              statement:        { type: 'string' },
              category:         { type: 'string' },
              metric:           { type: 'string' },
              topic:            { type: 'string' },
              description:      { type: 'string' },
              direction:        { type: 'string' },
              horizon:          { type: 'string' },
              timeline:         { type: 'string' },
              segment_name:     { type: 'string' },
              is_segment_level: { type: 'boolean' },

              measures: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['role', 'value_raw', 'unit'],
                  properties: {
                    role:       { type: 'string' },
                    value:      { type: 'number' },
                    value_raw:  { type: 'string' },
                    unit:       { type: 'string' },
                    multiplier: { type: 'number' },
                    period: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['start', 'end', 'type'],
                      properties: {
                        start: { type: 'string' },
                        end:   { type: 'string' },
                        type:  { type: 'string' },
                      },
                    },
                  },
                },
              },

              details: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'source_slide', 'source_context_raw',
                  'is_conditional', 'confidence_level', 'metric_family',
                  'trigger', 'analyst_firm', 'reason', 'outlook', 'relative_to',
                ],
                properties: {
                  // PPT coordinate fields
                  source_slide:        { type: 'number' },
                  source_context_raw:  { type: 'string' },
                  // guidance / future_target
                  is_conditional:      { type: 'boolean' },
                  condition:           { type: 'string' },
                  timeline_raw:        { type: 'string' },
                  // growth_forecast
                  confidence_level:    { type: 'string' },
                  // industry_signal / industry_signals
                  drivers:             { type: 'array', items: { type: 'string' } },
                  // capital_allocation
                  return_expectation:  { type: 'string' },
                  // disclosure_quality
                  trigger:             { type: 'string' },
                  management_framing:  { type: 'string' },
                  severity_of_issue:   { type: 'string' },
                  // earnings_quality
                  impact_on_reported_earnings: { type: 'string' },
                  // kpi
                  metric_family:       { type: 'string' },
                  is_peer_benchmark:   { type: 'boolean' },
                  // analyst_questions (unused for PPT but kept for schema parity)
                  analyst_firm:        { type: 'string' },
                  // guidance_revision
                  reason:              { type: 'string' },
                  // pricing_power
                  realization_gap:     { type: 'string' },
                  outlook:             { type: 'string' },
                  // competitive_position
                  relative_to:         { type: 'string' },
                  evidence_raw:        { type: 'string' },
                  // mgmt_tone
                  evidence:            { type: 'array', items: { type: 'string' } },
                  notable_contrast: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['exists', 'primary_tone', 'contrasting_tone', 'primary_topic', 'contrasting_topic', 'statement'],
                    properties: {
                      exists:            { type: 'boolean' },
                      primary_tone:      { type: 'string' },
                      contrasting_tone:  { type: 'string' },
                      primary_topic:     { type: 'string' },
                      contrasting_topic: { type: 'string' },
                      statement:         { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        new_kpis: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['abbr', 'full_form', 'kpi_type', 'denomination'],
            properties: {
              abbr:         { type: 'string' },
              full_form:    { type: 'string' },
              kpi_type:     { type: 'string', enum: ['customer_kpis', 'industry_specific'] },
              denomination: { type: 'string', enum: ['rupee', 'percentage', 'ratio', 'other'] },
            },
          },
        },
      },
    },
  },
};

async function main() {
  const existing = await prisma.skill.findUnique({ where: { slug: SKILL_SLUG } });

  if (existing) {
    const updated = await prisma.skill.update({
      where: { slug: SKILL_SLUG },
      data:  { outputSchema: OUTPUT_SCHEMA, promptTemplate: PROMPT_TEMPLATE_PPT, updatedAt: new Date() },
    });
    console.log(`Updated skill "${SKILL_SLUG}" — model: ${updated.model}, maxTokens: ${updated.maxTokens}`);
  } else {
    const created = await prisma.skill.create({
      data: {
        slug:           SKILL_SLUG,
        name:           'PPT Signal Extraction V2',
        description:    'Extracts 12 structured signal categories from investor presentation PDFs into transcript_signals_v2',
        model:          'google/gemini-3.5-flash',
        maxTokens:      130000,
        promptKey:      'ppt_call_v2',
        promptTemplate: PROMPT_TEMPLATE_PPT,
        outputSchema:   OUTPUT_SCHEMA,
        isActive:       true,
      },
    });
    console.log(`Created skill "${SKILL_SLUG}" — id: ${created.id}`);
  }

  console.log('Done.');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
