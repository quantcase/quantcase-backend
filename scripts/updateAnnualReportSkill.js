'use strict';

/**
 * Creates or updates the summarization-v2-annual-report skill in the DB.
 *
 * Uses the same transcript_signals_v2 table as summarization-v2 and
 * summarization-v2-ppt. Signal shape is identical; differences:
 *   - source_context enum = 8 annual report section slugs
 *   - signal_type enum adds annual-report-specific types:
 *     financial_figure, risk_factor, contingent_liability, governance_signal,
 *     strategic_claim, m_and_a, leadership_statement, guidance_revision,
 *     earnings_quality, disclosure_quality
 *   - details{} carries fiscal_year, is_consolidated, and type-specific extras
 *
 * Run: node scripts/updateAnnualReportSkill.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { PROMPT_TEMPLATE_AR } = require('../prompts/annual_report_call_v2');

const SKILL_SLUG = 'summarization-v2-annual-report';

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'summarization_v2_annual_report',
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
                enum: [
                  'chairman_letter', 'ceo_letter', 'board_report', 'mda',
                  'financial_statements', 'notes_to_accounts', 'risk_section',
                  'governance_section',
                ],
              },
              signal_type: {
                type: 'string',
                enum: [
                  'financial_figure', 'guidance', 'growth_forecast',
                  'capital_allocation', 'risk_factor', 'contingent_liability',
                  'governance_signal', 'strategic_claim', 'm_and_a', 'kpi',
                  'leadership_statement', 'milestone', 'ongoing',
                  'industry_signal', 'disclosure_quality', 'earnings_quality',
                  'guidance_revision',
                ],
              },
              impact:           { type: 'string', enum: ['high', 'medium', 'low'] },
              severity:         { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
              statement:        { type: ['string', 'null'] },
              category:         { type: 'string' },
              metric:           { type: 'string' },
              topic:            { type: 'string' },
              description:      { type: 'string' },
              direction:        { type: 'string' },
              horizon:          { type: 'string' },
              timeline:         { type: 'string' },
              segment_name:     { type: 'string' },
              is_segment_level: { type: 'boolean' },
              fiscal_year:      { type: 'string' },

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
                required: [],
                properties: {
                  // financial_figure
                  financial_year:    { type: 'string' },
                  is_consolidated:   { type: 'boolean' },
                  accounting_note:   { type: 'string' },
                  is_adjusted:       { type: 'boolean' },
                  // guidance / growth_forecast
                  is_conditional:    { type: 'boolean' },
                  condition:         { type: 'string' },
                  confidence_level:  { type: 'string' },
                  // capital_allocation
                  source_of_funds:   { type: 'string' },
                  capex_purpose:     { type: 'string' },
                  return_target:     { type: 'string' },
                  // risk_factor
                  mitigation_stated:   { type: 'boolean' },
                  mitigation_summary:  { type: 'string' },
                  risk_owner:          { type: 'string' },
                  // contingent_liability
                  dispute_description: { type: 'string' },
                  forum:               { type: 'string' },
                  period_of_dispute:   { type: 'string' },
                  company_position:    { type: 'string' },
                  related_party:       { type: 'boolean' },
                  // governance_signal
                  party_name:      { type: 'string' },
                  nature_of_txn:   { type: 'string' },
                  approval_status: { type: 'string' },
                  auditor_name:    { type: 'string' },
                  is_arms_length:  { type: 'boolean' },
                  // strategic_claim
                  evidence_cited: { type: 'string' },
                  claim_type:     { type: 'string' },
                  // m_and_a
                  target_name:          { type: 'string' },
                  deal_status:          { type: 'string' },
                  strategic_rationale:  { type: 'string' },
                  deal_structure:       { type: 'string' },
                  goodwill_created:     { type: 'string' },
                  synergy_target:       { type: 'string' },
                  integration_status:   { type: 'string' },
                  revenue_contribution: { type: 'string' },
                  // kpi
                  kpi_definition: { type: 'string' },
                  target:         { type: 'string' },
                  // leadership_statement
                  author_name: { type: 'string' },
                  author_role: { type: 'string' },
                  // milestone
                  achievement_context: { type: 'string' },
                  // ongoing
                  initiative_name:    { type: 'string' },
                  completion_target:  { type: 'string' },
                  current_progress:   { type: 'string' },
                  // industry_signal
                  market_name: { type: 'string' },
                  data_source: { type: 'string' },
                  drivers:     { type: 'array', items: { type: 'string' } },
                  // disclosure_quality
                  prior_disclosure:  { type: 'string' },
                  current_status:    { type: 'string' },
                  concern_rationale: { type: 'string' },
                  l2_flag:           { type: 'boolean' },
                  // earnings_quality
                  impact_on_reported_earnings: { type: 'string' },
                  // guidance_revision
                  prior_guidance_source:  { type: 'string' },
                  variance_description:   { type: 'string' },
                  management_explanation: { type: 'string' },
                  prior_guidance_quoted:  { type: 'boolean' },
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
              kpi_type:     { type: 'string', enum: ['financial', 'operational', 'customer', 'esg', 'governance', 'industry_specific'] },
              denomination: { type: 'string', enum: ['rupee', 'percentage', 'ratio', 'count', 'other'] },
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
      data:  { outputSchema: OUTPUT_SCHEMA, promptTemplate: PROMPT_TEMPLATE_AR, updatedAt: new Date() },
    });
    console.log(`Updated skill "${SKILL_SLUG}" — model: ${updated.model}, maxTokens: ${updated.maxTokens}`);
  } else {
    const created = await prisma.skill.create({
      data: {
        slug:           SKILL_SLUG,
        name:           'Annual Report Signal Extraction V2',
        description:    'Extracts 17 structured signal types from Indian annual report PDFs into transcript_signals_v2',
        model:          'google/gemini-2.5-flash-lite',
        maxTokens:      130000,
        promptKey:      'annual_report_call_v2',
        promptTemplate: PROMPT_TEMPLATE_AR,
        outputSchema:   OUTPUT_SCHEMA,
        isActive:       true,
      },
    });
    console.log(`Created skill "${SKILL_SLUG}" — id: ${created.id}`);
  }

  const afterEnum = OUTPUT_SCHEMA.json_schema.schema.properties.signals.items.properties.signal_type.enum;
  console.log(`signal_type enum (${afterEnum.length}): [${afterEnum.join(', ')}]`);
  console.log('Done.');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
