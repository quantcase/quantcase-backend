'use strict';

/**
 * REVERT SCRIPT — restores the summarization-v2 output_schema to the pre-2026-06-10
 * flat schema (52 required fields, signal_type enum uses "growth_forecast").
 * Use this to undo changes applied by updateSummarizationV2Skill.js.
 *
 * Run:  node scripts/revertSummarizationV2Skill.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');

const ORIGINAL_OUTPUT_SCHEMA = {
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
              'industry_category', 'allocation_category', 'disclosure_category',
              'distribution_category', 'question_nature', 'comparison_dimension',
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
              signal_type:   { type: 'string' },
              value_prior:   { type: ['number', 'null'] },
              analyst_firm:  { type: ['string', 'null'] },
              claimed_unit:  { type: ['string', 'null'] },
              evidence_raw:  { type: ['string', 'null'] },
              guided_value:  { type: ['number', 'null'] },
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
              notable_contrast: {
                type: ['object', 'null'],
                properties: {
                  exists:            { type: 'boolean' },
                  statement:         { type: ['string', 'null'] },
                  primary_tone:      { type: ['string', 'null'] },
                  primary_topic:     { type: ['string', 'null'] },
                  contrasting_tone:  { type: ['string', 'null'] },
                  contrasting_topic: { type: ['string', 'null'] },
                },
                additionalProperties: true,
              },
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
  if (!before) throw new Error('Skill "summarization-v2" not found');

  const currentShape = before.outputSchema?.json_schema?.schema?.properties?.signals?.items;
  const isAnyOf   = !!currentShape?.anyOf;
  const isFlat    = !!currentShape?.required;
  console.log(`Current schema shape: ${isAnyOf ? 'anyOf (v2)' : isFlat ? 'flat (original)' : 'unknown'}`);

  const updated = await prisma.skill.update({
    where: { slug: 'summarization-v2' },
    data:  { outputSchema: ORIGINAL_OUTPUT_SCHEMA },
  });

  const afterRequired = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required?.length;
  console.log(`Reverted — signals.items.required = ${afterRequired} fields`);
  console.log('Done.');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
