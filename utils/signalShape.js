'use strict';

/**
 * Canonical signal type vocabulary for L1 extraction.
 * Both the transcript and QE workers emit signals with these types.
 */
const SIGNAL_TYPES = Object.freeze({
  KPI:              'kpi',           // numeric financial/operational metric
  GOVERNANCE:       'governance',    // board/disclosure quality flag
  ENTITY:           'entity',        // named entity (person, segment, geography)
  MILESTONE:        'milestone',     // forward-looking target or disclosed achievement
  INDUSTRY:         'industry',      // industry-level demand/supply/margin signal
  CUSTOMER:         'customer',      // customer-traction signal (growth, churn, ARPU, …)
  FINANCIAL_HEALTH: 'financial_health', // qualitative financial-strength driver
  TONE:             'tone',          // management tone signal
  OFACTOR:          'ofactor_section',
  MANAGEMENT:       'management_score',
});

/**
 * Controlled metric_family vocabulary — used for lens composition and filtering.
 */
const METRIC_FAMILIES = Object.freeze({
  PROFITABILITY: 'profitability',
  GROWTH:        'growth',
  GOVERNANCE:    'governance',
  CUSTOMER:      'customer',
  CAPITAL:       'capital',
  INDUSTRY:      'industry',
  QUALITATIVE:   'qualitative',
  MILESTONE:     'milestone',
  OFACTOR:       'ofactor',
});

/**
 * Impact and severity vocabularies — LLM assigns these at extraction time.
 */
const IMPACT   = Object.freeze(['high', 'medium', 'low']);
const SEVERITY = Object.freeze(['critical', 'high', 'medium', 'low', 'informational']);

/**
 * The canonical flat shape every L1 signal must conform to.
 * Workers validate / default-fill using this before writing to the Signal Store.
 *
 * Required fields (must not be null/undefined when written):
 *   call_id, ticker, company, source_type, signal_type, metric,
 *   source_hash, prompt_v, extractor_model, lineage_id
 *
 * All other fields have sensible defaults applied by normalizeSignal().
 */
const SIGNAL_DEFAULTS = {
  fiscal_year:     null,
  quarter:         null,
  call_date:       null,
  value:           null,
  raw_value:       null,
  unit:            null,
  multiplier:      1,
  w:               1.0,
  b:               0.0,
  confidence:      null,
  time_horizon:    null,
  esg_tag:         null,
  risk_tag:        null,
  sector:          null,
  metric_family:   null,
  impact:          null,
  severity:        null,
  schema_v:        '2.0.0',
  statement:       null,
  start_date:      null,
  end_date:        null,
  period_type:     null,
};

/**
 * Normalise a raw LLM signal object into the canonical ExtractedSignal shape.
 * Applies defaults, strips unknown keys, and validates required fields.
 *
 * @param {object} raw  — signal object from LLM or worker code
 * @param {object} base — shared fields (call_id, ticker, company, source_type, source_hash, prompt_v, extractor_model)
 * @returns {object}    — ready to pass to prisma.extractedSignal.createMany
 * @throws  if required fields are missing after merge
 */
function normalizeSignal(raw, base) {
  const merged = { ...SIGNAL_DEFAULTS, ...base, ...raw };

  // Validate required fields
  const required = ['call_id', 'ticker', 'company', 'source_type', 'signal_type', 'metric', 'source_hash', 'prompt_v', 'extractor_model', 'lineage_id'];
  for (const field of required) {
    if (!merged[field]) throw new Error(`Signal missing required field: ${field}`);
  }

  // Clamp impact/severity to known vocab (don't throw — just null out unknowns)
  if (merged.impact   && !IMPACT.includes(merged.impact))     merged.impact   = null;
  if (merged.severity && !SEVERITY.includes(merged.severity)) merged.severity = null;

  // Ensure value is a number or null
  if (merged.value !== null && merged.value !== undefined) {
    const v = parseFloat(merged.value);
    merged.value    = isNaN(v) ? null : v;
    merged.raw_value = merged.raw_value ?? String(merged.value);
  }

  // Strip fields that aren't in the Prisma model to avoid createMany errors
  const allowed = new Set([
    'call_id','ticker','company','fiscal_year','quarter','call_date',
    'source_type','signal_type','metric','value','raw_value','unit','multiplier',
    'w','b','confidence','time_horizon','esg_tag','risk_tag','sector',
    'metric_family','impact','severity','source_hash','prompt_v','schema_v',
    'extractor_model','lineage_id','statement','start_date','end_date','period_type',
  ]);
  const out = {};
  for (const key of allowed) out[key] = merged[key] ?? SIGNAL_DEFAULTS[key] ?? null;
  return out;
}

module.exports = { SIGNAL_TYPES, METRIC_FAMILIES, IMPACT, SEVERITY, SIGNAL_DEFAULTS, normalizeSignal };
