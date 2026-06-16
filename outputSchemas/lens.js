'use strict';

// OpenRouter strict mode rules:
//  1. strict: true
//  2. Every object needs additionalProperties: false
//  3. Every property defined must appear in required[] (use ["type","null"] for optional fields)

// ─── Shared signal row (used by top_signals in all lenses) ───────────────────
const signalItem = {
  type:                 'object',
  additionalProperties: false,
  required: [
    'signal_id', 'metric', 'label',
    'announcement_date',
    'value_at_announcement', 'value_targeted', 'guided_value', 'guided_date',
    'target_date',
    'actual_value', 'actual_date',
    'unit', 'delta', 'delta_pct',
    'direction', 'impact', 'statement',
    'original_statement',
  ],
  properties: {
    signal_id:             { type: ['string',  'null'] },
    metric:                { type: 'string' },
    label:                 { type: 'string' },
    // Guidance-track-record fields
    announcement_date:     { type: ['string',  'null'] },
    value_at_announcement: { type: ['number',  'null'] },
    value_targeted:        { type: ['number',  'null'] },
    // Generic "guided" fields used by non-guidance lenses (capital-allocation, competition, etc.)
    guided_value:          { type: ['number',  'null'] },
    guided_date:           { type: ['string',  'null'] },
    target_date:           { type: ['string',  'null'] },
    actual_value:          { type: ['number',  'null'] },
    actual_date:           { type: ['string',  'null'] },
    unit:                  { type: ['string',  'null'] },
    delta:                 { type: ['number',  'null'] },
    delta_pct:             { type: ['number',  'null'] },
    direction: {
      type: 'string',
      enum: ['beat', 'miss', 'in_line', 'tracking', 'major_miss', 'promise_silently_dropped', 'none'],
    },
    impact:                { type: 'string', enum: ['high', 'medium', 'low'] },
    statement:             { type: ['string',  'null'] },
    original_statement:    { type: 'string' },
  },
};

// ─── Pattern evidence item ────────────────────────────────────────────────────
// One piece of verifiable evidence backing a pattern (quote + date + signal_id).
const patternEvidence = {
  type:                 'object',
  additionalProperties: false,
  required: ['period', 'signal_id', 'value', 'quote'],
  properties: {
    period:    { type: 'string' },              // e.g. "Q3 FY26" or "2025-10-15"
    signal_id: { type: 'string' },              // traceability back to L1 signal
    value:     { type: ['number',  'null'] },   // numeric value if applicable (e.g. mention count)
    quote:     { type: 'string' },              // verbatim or paraphrased management text
  },
};

// ─── Pattern item (one of the 6 behavioral pattern types) ────────────────────
const patternItem = {
  type:                 'object',
  additionalProperties: false,
  required: [
    'type', 'confidence', 'confidence_reason',
    'label', 'sentence',
    'shape_data', 'shape_label',
    'evidence',
    'direction', 'impact',
  ],
  properties: {
    // Pattern type — maps to the 6 types from the doc
    type: {
      type: 'string',
      enum: [
        'drumbeat',             // Strategic theme gaining/losing management emphasis across quarters
        'emergence',            // New initiative/risk appearing for first time then accelerating
        'narrative_gap',        // Management emphasis vs analyst question density gap
        'tone_divergence',      // Bullish tone vs decelerating KPI — narrative inflation warning
        'going_quiet',          // Topic heavily promoted, now barely mentioned — deprioritisation
        'street_pressure',      // Analyst question clustering — where consensus is forming
      ],
    },

    // 0.0–1.0 confidence that this pattern has real evidence behind it.
    // 0.0 = no data, pattern is structural placeholder only.
    // 1.0 = strong multi-quarter evidence with exact quotes and signal IDs.
    confidence:        { type: 'number' },
    confidence_reason: { type: 'string' },  // why this confidence score was assigned

    // The "sentence" — one-line plain-language causal claim leading with the delta
    // e.g. "Data centre investment silent for 4 quarters, rising to 12 references by Q4 — signals capex pivot."
    label:    { type: 'string' },  // 3–6 word title, e.g. "Data Centre Drumbeat"
    sentence: { type: 'string' },  // the full one-liner

    // The "shape" — sparkline or bar data the UI can render
    // For drumbeat/emergence/going_quiet: array of { period, value } frequency points
    // For narrative_gap: [{ label: "Management", value: 35 }, { label: "Analysts", value: 5 }]
    // For tone_divergence: [{ period, tone_score, kpi_value }]
    // For street_pressure: [{ label: "Theme", value: question_count }] sorted desc
    shape_data:  { type: ['string', 'null'] },  // JSON-stringified array — kept as string to avoid schema explosion
    shape_label: { type: ['string', 'null'] },  // human label for the shape, e.g. "Mention frequency Q1→Q4 FY26"

    // Evidence array — tap-to-verify sources
    evidence: {
      type:  'array',
      items: patternEvidence,
    },

    // How the pattern resolves — is it a positive signal, risk, or neutral
    direction: {
      type: 'string',
      enum: ['positive', 'negative', 'neutral', 'watch'],
    },
    impact: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

// ─── Root lens output schema ──────────────────────────────────────────────────
const lensOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'lens_score',
    strict: true,
    schema: {
      type:                 'object',
      additionalProperties: false,
      required: ['score', 'status', 'takeaway', 'key_metrics', 'highlights', 'risks', 'top_signals', 'patterns'],
      properties: {
        score:       { type: 'integer' },
        status:      { type: 'string', enum: ['STRONG', 'MODERATE', 'WEAK'] },
        takeaway:    { type: 'string' },
        key_metrics: {
          type:                 'object',
          additionalProperties: { type: 'string' },
        },
        highlights: { type: 'array', items: { type: 'string' } },
        risks:      { type: 'array', items: { type: 'string' } },

        // Generic tabular rows — the track record table.
        // All lenses use this. Fields not relevant to a lens are null.
        top_signals: {
          type:  'array',
          items: signalItem,
        },

        // Behavioral pattern analysis — six types, all always emitted by management lenses.
        // Non-management lenses emit an empty array [].
        patterns: {
          type:  'array',
          items: patternItem,
        },
      },
    },
  },
};

module.exports = { lensOutputSchema };
