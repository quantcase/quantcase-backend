'use strict';

/**
 * Updates the summarization-v2 skill with the generic signal schema.
 *
 * Schema change: compact envelope (signal_id/source/type/impact/severity + free-form "data")
 * → flat generic fields (category, metric, topic, description, direction, horizon,
 *   timeline, segment_name, is_segment_level, statement) + measures[] + details{}.
 *
 * Prompt change: 14 bespoke field-sets collapsed into ONE generic signal shape.
 * signal_type rename: company_growth_forecast → growth_forecast.
 * All SIGNAL TYPES, DATE RULES, KPI RULES, IMPACT & SEVERITY RULES, and EXTRACTION RULES
 * are preserved unchanged.
 *
 * Run: node scripts/updateSummarizationV2SkillCompact.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { PROMPT_TEMPLATE_V2 } = require('../prompts/transcript_call_v2');

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'summarization_v2',
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
                enum: ['opening_remarks', 'management_presentation', 'analyst_qa'],
              },
              signal_type: {
                type: 'string',
                enum: [
                  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
                  'distribution_customer', 'growth_forecast', 'earnings_quality', 'kpi',
                  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
                  'competitive_position', 'claim',
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
                  'is_conditional', 'confidence_level', 'metric_family',
                  'trigger', 'analyst_firm', 'reason', 'outlook', 'relative_to',
                ],
                properties: {
                  // guidance
                  is_conditional:              { type: 'boolean' },
                  condition:                   { type: 'string' },
                  // industry_signal
                  drivers:                     { type: 'array', items: { type: 'string' } },
                  // capital_allocation
                  return_expectation:          { type: 'string' },
                  // disclosure_quality
                  trigger:                     { type: 'string' },
                  management_framing:          { type: 'string' },
                  severity_of_issue:           { type: 'string' },
                  // growth_forecast
                  confidence_level:            { type: 'string' },
                  // earnings_quality
                  impact_on_reported_earnings: { type: 'string' },
                  // kpi
                  metric_family:               { type: 'string' },
                  // mgmt_tone
                  evidence:                    { type: 'array', items: { type: 'string' } },
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
                  // analyst_questions
                  analyst_firm:                { type: 'string' },
                  // guidance_revision
                  reason:                      { type: 'string' },
                  // pricing_power
                  realization_gap:             { type: 'string' },
                  outlook:                     { type: 'string' },
                  // competitive_position
                  relative_to:                 { type: 'string' },
                  evidence_raw:                { type: 'string' },
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
  const before = await prisma.skill.findUnique({ where: { slug: 'summarization-v2' } });
  if (!before) throw new Error('Skill "summarization-v2" not found in DB');

  const currentEnum = before.outputSchema?.json_schema?.schema?.properties?.signals?.items?.properties?.signal_type?.enum ?? [];
  console.log(`Before: signal_type enum = [${currentEnum.join(', ')}]`);

  const updated = await prisma.skill.update({
    where: { slug: 'summarization-v2' },
    data:  { outputSchema: OUTPUT_SCHEMA, promptTemplate: PROMPT_TEMPLATE_V2, updatedAt: new Date() },
  });

  const afterEnum = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.properties?.signal_type?.enum ?? [];
  const afterReq  = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required ?? [];
  console.log(`After:  signal_type enum  = [${afterEnum.join(', ')}]`);
  console.log(`After:  required fields   = [${afterReq.join(', ')}]`);
  console.log('Prompt updated: yes');
  console.log('Done — summarization-v2 skill updated to generic signal schema.');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
