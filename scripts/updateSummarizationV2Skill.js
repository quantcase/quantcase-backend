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
            ],
            properties: {
              unit:          { type: ['string', 'null'] },
              topic:         { type: ['string', 'null'] },
              value:         { type: ['number', 'null'] },
              impact:        { enum: ['high', 'medium', 'low'], type: 'string' },
              metric:        { type: ['string', 'null'] },
              reason:        { type: ['string', 'null'] },
              drivers:       { type: ['array', 'null'], items: { type: 'string' } },
              horizon:       { type: ['string', 'null'] },
              outlook:       { type: ['string', 'null'] },
              trigger:       { type: ['string', 'null'] },
              end_date:      { type: ['string', 'null'] },
              evidence:      { type: ['array', 'null'], items: { type: 'string' } },
              severity:      { enum: ['critical', 'high', 'medium', 'low', 'informational'], type: 'string' },
              timeline:      { type: ['string', 'null'] },
              condition:     { type: ['string', 'null'] },
              direction:     { type: ['string', 'null'] },
              signal_id:     { type: 'string' },
              statement:     { type: ['string', 'null'] },
              value_raw:     { type: ['string', 'null'] },
              multiplier:    { type: ['number', 'null'] },
              period_end:    { type: ['string', 'null'] },
              start_date:    { type: ['string', 'null'] },
              base_period:   { type: ['string', 'null'] },
              description:   { type: ['string', 'null'] },
              eq_category:   { type: ['string', 'null'] },
              guided_unit:   { type: ['string', 'null'] },
              period_type:   { type: ['string', 'null'] },
              relative_to:   { type: ['string', 'null'] },
              signal_type: {
                type: 'string',
                enum: [
                  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
                  'distribution_customer', 'company_growth_forecast', 'earnings_quality', 'kpi',
                  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
                  'competitive_position', 'claim',
                ],
              },
              value_prior:   { type: ['number', 'null'] },
              analyst_firm:  { type: ['string', 'null'] },
              claimed_unit:  { type: ['string', 'null'] },
              evidence_raw:  { type: ['string', 'null'] },
              guided_value:  { type: ['number', 'null'] },
              overall_tone:  { type: ['string', 'null'] },
              period_start:  { type: ['string', 'null'] },
              quantum_unit:  { type: ['string', 'null'] },
              segment_name:  { type: ['string', 'null'] },
              dominant_tone: { type: ['string', 'null'] },
              metric_family: { type: ['string', 'null'] },
              quantum_value: { type: ['number', 'null'] },
              target_period: { type: ['string', 'null'] },
              value_current: { type: ['number', 'null'] },
              actual_outcome: {
                type: ['object', 'null'],
                properties: {
                  value:  { type: ['number', 'null'] },
                  metric: { type: ['string', 'null'] },
                  period: { type: ['string', 'null'] },
                },
                additionalProperties: true,
              },
              claim_category:    { type: ['string', 'null'] },
              claimed_values:    { type: ['array', 'null'], items: { type: ['number', 'null'] } },
              is_conditional:    { type: ['boolean', 'null'] },
              prior_guidance: {
                type: ['object', 'null'],
                properties: {
                  value:  { type: ['number', 'null'] },
                  metric: { type: ['string', 'null'] },
                  period: { type: ['string', 'null'] },
                },
                additionalProperties: true,
              },
              question_topic:    { type: ['string', 'null'] },
              source_context: {
                enum: ['opening_remarks', 'management_presentation', 'analyst_qa'],
                type: 'string',
              },
              forecast_metric:   { type: ['string', 'null'] },
              metric_affected:   { type: ['string', 'null'] },
              question_nature:   { type: ['string', 'null'] },
              realization_gap:   { type: ['string', 'null'] },
              revision_nature:   { type: ['string', 'null'] },
              trend_direction:   { type: ['string', 'null'] },
              value_prior_raw:   { type: ['string', 'null'] },
              confidence_level:  { type: ['string', 'null'] },
              guided_value_raw:  { type: ['string', 'null'] },
              is_segment_level:  { type: ['boolean', 'null'] },
              notable_contrast:  { type: ['string', 'null'] },
              pass_through_raw:  { type: ['string', 'null'] },
              revised_guidance: {
                type: ['object', 'null'],
                properties: {
                  value:  { type: ['number', 'null'] },
                  metric: { type: ['string', 'null'] },
                  period: { type: ['string', 'null'] },
                },
                additionalProperties: true,
              },
              scale_metric_raw:       { type: ['string', 'null'] },
              claimed_value_raw:      { type: ['string', 'null'] },
              guidance_category:      { type: ['string', 'null'] },
              industry_category:      { type: ['string', 'null'] },
              pass_through_rate:      { type: ['number', 'null'] },
              quantum_value_raw:      { type: ['string', 'null'] },
              severity_of_issue:      { type: ['string', 'null'] },
              value_current_raw:      { type: ['string', 'null'] },
              baseline_value_raw:     { type: ['string', 'null'] },
              guided_growth_rate:     { type: ['number', 'null'] },
              management_framing:     { type: ['string', 'null'] },
              return_expectation:     { type: ['string', 'null'] },
              segment_or_channel:     { type: ['string', 'null'] },
              allocation_category:    { type: ['string', 'null'] },
              disclosure_category:    { type: ['string', 'null'] },
              guidance_period_end:    { type: ['string', 'null'] },
              source_statement_id:    { type: 'string' },
              comparison_dimension:   { type: ['string', 'null'] },
              distribution_category:  { type: ['string', 'null'] },
              guidance_period_start:  { type: ['string', 'null'] },
              guided_absolute_value:  { type: ['number', 'null'] },
              impact_on_reported_earnings: { type: ['string', 'null'] },
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
