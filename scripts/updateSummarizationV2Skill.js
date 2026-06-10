'use strict';

/**
 * Updates the summarization-v2 skill in DB with:
 *   1. The latest prompt from prompts/transcript_call_v2.js (PROMPT_TEMPLATE_V2)
 *   2. The output schema from the team doc (2026-06-10)
 *
 * Changes vs previous schema:
 *   - signal_type enum: "growth_forecast" → "company_growth_forecast"
 *   - Added "overall_tone" property
 *   - required list trimmed to 44 fields (removed industry_category, allocation_category,
 *     disclosure_category, distribution_category, question_nature, comparison_dimension)
 *
 * To revert: node scripts/revertSummarizationV2Skill.js
 * Run:       node scripts/updateSummarizationV2Skill.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { PROMPT_TEMPLATE_V2 } = require('../prompts/transcript_call_v2');

const NEW_OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'summarization_v2',
    schema: {
      type: 'object',
      required: ['signals', 'new_kpis'],
      properties: {
        signals: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'signal_id', 'source_statement_id', 'source_context', 'signal_type',
              'impact', 'severity', 'statement',
              'metric', 'value', 'value_raw', 'unit', 'multiplier',
              'start_date', 'end_date', 'period_type', 'metric_family',
              'is_segment_level', 'segment_name',
              'guidance_category', 'guided_value', 'guided_value_raw', 'guided_unit',
              'baseline_value_raw', 'guidance_period_start', 'guidance_period_end',
              'is_conditional', 'condition',
              'claim_category', 'claimed_values', 'claimed_value_raw', 'claimed_unit',
              'period_start', 'period_end',
              'forecast_metric', 'guided_growth_rate', 'guided_absolute_value',
              'base_period', 'target_period', 'confidence_level',
              'eq_category', 'metric_affected', 'impact_on_reported_earnings',
              'prior_guidance', 'revised_guidance', 'revision_nature', 'reason',
              // multi-type or quality-critical fields moved here to stay under Claude's 24-optional limit
              'topic', 'direction', 'timeline', 'description',
              'value_prior', 'value_current', 'value_current_raw', 'value_prior_raw',
              'trend_direction', 'overall_tone',
              'horizon', 'drivers', 'outlook', 'evidence', 'evidence_raw',
            ],
            properties: {
              unit:          { type: 'string' },
              topic:         { type: 'string' },
              value:         { type: 'number' },
              impact:        { enum: ['high', 'medium', 'low'], type: 'string' },
              metric:        { type: 'string' },
              reason:        { type: 'string' },
              drivers:       { type: 'array', items: { type: 'string' } },
              horizon:       { type: 'string' },
              outlook:       { type: 'string' },
              trigger:       { type: 'string' },
              end_date:      { type: 'string' },
              evidence:      { type: 'array', items: { type: 'string' } },
              severity:      { enum: ['critical', 'high', 'medium', 'low', 'informational'], type: 'string' },
              timeline:      { type: 'string' },
              condition:     { type: 'string' },
              direction:     { type: 'string' },
              signal_id:     { type: 'string' },
              statement:     { type: 'string' },
              value_raw:     { type: 'string' },
              multiplier:    { type: 'number' },
              period_end:    { type: 'string' },
              start_date:    { type: 'string' },
              base_period:   { type: 'string' },
              description:   { type: 'string' },
              eq_category:   { type: 'string' },
              guided_unit:   { type: 'string' },
              period_type:   { type: 'string' },
              relative_to:   { type: 'string' },
              signal_type: {
                type: 'string',
                enum: [
                  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
                  'distribution_customer', 'company_growth_forecast', 'earnings_quality', 'kpi',
                  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
                  'competitive_position', 'claim',
                ],
              },
              value_prior:   { type: 'number' },
              analyst_firm:  { type: 'string' },
              claimed_unit:  { type: 'string' },
              evidence_raw:  { type: 'string' },
              guided_value:  { type: 'number' },
              overall_tone:  { type: 'string' },
              period_start:  { type: 'string' },
              quantum_unit:  { type: 'string' },
              segment_name:  { type: 'string' },
              dominant_tone: { type: 'string' },
              metric_family: { type: 'string' },
              quantum_value: { type: 'number' },
              target_period: { type: 'string' },
              value_current: { type: 'number' },
              actual_outcome: {
                type: 'object',
                required: ['value', 'metric', 'period'],
                properties: {
                  value:  { type: 'number' },
                  metric: { type: 'string' },
                  period: { type: 'string' },
                },
                additionalProperties: true,
              },
              claim_category:    { type: 'string' },
              claimed_values:    { type: 'array', items: { type: 'number' } },
              is_conditional:    { type: 'boolean' },
              prior_guidance: {
                type: 'object',
                required: ['value', 'metric', 'period'],
                properties: {
                  value:  { type: 'number' },
                  metric: { type: 'string' },
                  period: { type: 'string' },
                },
                additionalProperties: true,
              },
              question_topic:    { type: 'string' },
              source_context: {
                enum: ['opening_remarks', 'management_presentation', 'analyst_qa'],
                type: 'string',
              },
              forecast_metric:   { type: 'string' },
              metric_affected:   { type: 'string' },
              question_nature:   { type: 'string' },
              realization_gap:   { type: 'string' },
              revision_nature:   { type: 'string' },
              trend_direction:   { type: 'string' },
              value_prior_raw:   { type: 'string' },
              confidence_level:  { type: 'string' },
              guided_value_raw:  { type: 'string' },
              is_segment_level:  { type: 'boolean' },
              notable_contrast:  { type: 'string' },
              pass_through_raw:  { type: 'string' },
              revised_guidance: {
                type: 'object',
                required: ['value', 'metric', 'period'],
                properties: {
                  value:  { type: 'number' },
                  metric: { type: 'string' },
                  period: { type: 'string' },
                },
                additionalProperties: true,
              },
              scale_metric_raw:       { type: 'string' },
              claimed_value_raw:      { type: 'string' },
              guidance_category:      { type: 'string' },
              industry_category:      { type: 'string' },
              pass_through_rate:      { type: 'number' },
              quantum_value_raw:      { type: 'string' },
              severity_of_issue:      { type: 'string' },
              value_current_raw:      { type: 'string' },
              baseline_value_raw:     { type: 'string' },
              guided_growth_rate:     { type: 'number' },
              management_framing:     { type: 'string' },
              return_expectation:     { type: 'string' },
              segment_or_channel:     { type: 'string' },
              allocation_category:    { type: 'string' },
              disclosure_category:    { type: 'string' },
              guidance_period_end:    { type: 'string' },
              source_statement_id:    { type: 'string' },
              comparison_dimension:   { type: 'string' },
              distribution_category:  { type: 'string' },
              guidance_period_start:  { type: 'string' },
              guided_absolute_value:  { type: 'number' },
              impact_on_reported_earnings: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        new_kpis: {
          type: 'array',
          items: {
            type: 'object',
            required: ['abbr', 'full_form', 'kpi_type', 'denomination'],
            properties: {
              abbr:         { type: 'string' },
              kpi_type:     { enum: ['customer_kpis', 'industry_specific'], type: 'string' },
              full_form:    { type: 'string' },
              denomination: { enum: ['rupee', 'percentage', 'ratio', 'other'], type: 'string' },
            },
          },
        },
      },
    },
    strict: false,
  },
};

async function main() {
  const before = await prisma.skill.findUnique({ where: { slug: 'summarization-v2' } });
  if (!before) throw new Error('Skill "summarization-v2" not found in DB');

  const currentReq = before.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required ?? [];
  console.log(`Before: ${currentReq.length} required fields`);

  const updated = await prisma.skill.update({
    where: { slug: 'summarization-v2' },
    data:  { outputSchema: NEW_OUTPUT_SCHEMA, promptTemplate: PROMPT_TEMPLATE_V2, updatedAt: new Date() },
  });

  const afterReq = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required ?? [];
  const signalTypeEnum = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.properties?.signal_type?.enum ?? [];
  console.log(`After:  ${afterReq.length} required fields`);
  console.log(`signal_type enum: ${signalTypeEnum.join(', ')}`);
  console.log('Prompt updated: yes');
  console.log('Done — summarization-v2 skill updated.');
  console.log('To revert: node scripts/revertSummarizationV2Skill.js');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
