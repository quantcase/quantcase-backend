'use strict';

/**
 * Updates the summarization-v2 skill with a compact envelope-based schema.
 *
 * Schema change: flat signal object → 6-field envelope + free-form "data" object.
 * This sidesteps Claude's grammar compilation limits (optional count, union types,
 * compiled grammar size) by declaring only the 6 envelope fields in the schema
 * grammar and letting "data" be additionalProperties:true.
 *
 * Prompt change: OUTPUT FORMAT section updated to match — all type-specific
 * fields move under "data". All SIGNAL TYPES, DATE RULES, KPI RULES, IMPACT &
 * SEVERITY RULES, and EXTRACTION RULES are unchanged.
 *
 * To revert: node scripts/revertSummarizationV2Skill.js
 * Run:       node scripts/updateSummarizationV2SkillCompact.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const { PROMPT_TEMPLATE_V2 } = require('../prompts/transcript_call_v2');

const COMPACT_OUTPUT_SCHEMA = {
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
            required: ['signal_id', 'source_statement_id', 'source_context', 'signal_type', 'impact', 'severity', 'data'],
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
                  'distribution_customer', 'company_growth_forecast', 'earnings_quality', 'kpi',
                  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
                  'competitive_position', 'claim',
                ],
              },
              impact:   { type: 'string', enum: ['high', 'medium', 'low'] },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
              data: {
                type: 'object',
                additionalProperties: true,
                required: ['statement'],
                properties: {
                  statement: { type: 'string' },
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

  const currentReq = before.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required ?? [];
  console.log(`Before: signal item required fields = [${currentReq.join(', ')}]`);

  const updated = await prisma.skill.update({
    where: { slug: 'summarization-v2' },
    data:  { outputSchema: COMPACT_OUTPUT_SCHEMA, promptTemplate: PROMPT_TEMPLATE_V2, updatedAt: new Date() },
  });

  const afterReq = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.required ?? [];
  const signalTypeEnum = updated.outputSchema?.json_schema?.schema?.properties?.signals?.items?.properties?.signal_type?.enum ?? [];
  console.log(`After:  signal item required fields = [${afterReq.join(', ')}]`);
  console.log(`signal_type enum: ${signalTypeEnum.join(', ')}`);
  console.log('Prompt updated: yes');
  console.log('Done — summarization-v2 skill updated to compact envelope schema.');
  console.log('Worker note: sig.<field> → sig.data.<field> in extractMetric()');
  console.log('To revert: node scripts/revertSummarizationV2Skill.js');
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
