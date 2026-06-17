'use strict';

// =============================================================================
// LENS OUTPUT SCHEMA — L2 v5 (open-vocabulary build)
// =============================================================================
// THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR THE OUTPUT CONTRACT.
// - lens-bridge.md is the runtime prompt that EMITS JSON conforming to this schema.
// - Guidance_l2_v5_refined.md is ANALYTICAL METHODOLOGY ONLY. Where the prose in
//   v5 disagrees with this file on output shape, field names, or date format,
//   THIS FILE WINS.
//
// OpenRouter strict-mode rules (all enforced below):
//   1. strict: true
//   2. Every object has additionalProperties: false
//   3. Every property in `properties` also appears in `required[]`
//      (optional fields are modelled as ["<type>","null"], not by omission)
//
// OPEN-VOCABULARY DESIGN (this build):
//   The SCHEMA defines STRUCTURE, not vocabulary. The analytic classification
//   fields — `direction`, `impact`, `pattern_type` — are OPEN strings. Their
//   former enum members survive only as SUGGESTIONS, carried in each field's
//   `description` so the model sees them but is never forced into them. A novel
//   pattern that fits none of the named types keeps its own label instead of
//   being mislabelled to the nearest box.
//
//   Two enums are deliberately KEPT enforced because they are STRUCTURAL, not
//   analytic:
//     - `kind`   — the discriminator the whole two-array contract routes on.
//     - `status` — a computed bucket of `score`, not an analysis output.
//   To open those too, swap their `enum` for `{ type: 'string', description }`
//   exactly as done below for the analytic fields.
//
//   Suggestions live in `description`, NOT in the JSON-Schema `examples`
//   keyword: `examples` is outside the OpenRouter / OpenAI strict subset and can
//   get the schema rejected. `description` is in-subset and is forwarded to the
//   model.
//
// ARCHITECTURE (per product owner):
//   lens (envelope)
//     |- top_signals[]  — children use the SHARED superset `childItem`.
//     \- patterns[]      — children ALSO use the SHARED superset `childItem`, plus
//                          the pattern-specific evidence array.
//
//   Both arrays share ONE child schema (childItem). This gives the UI a single
//   render contract and avoids schema explosion. Which fields must be non-null
//   for a given child is carried by the PROMPT, NOT the schema, because
//   OpenRouter strict mode cannot express conditional/required-by-discriminator
//   rules. The PROMPT is also where pattern openness is governed: keep the
//   vocabulary "suggested, not exhaustive" there to match this build.
//
// L2 v5 conformance notes:
//   - No delta / delta_pct fields. `direction` is resolved by pure comparison
//     (actual vs guided), never by subtraction.
//   - No value_at_announcement field (only ever served banned delta inference).
//   - Guidance commitments support a single point (value_targeted) OR a range
//     (value_targeted_low / value_targeted_high).
//   - All quoted text is VERBATIM. No paraphrasing anywhere.
//   - Guidance-commitment fields (value_targeted* / target_date) are populated
//     ONLY for guidance_timebound / ongoing:timebound signals; actuals
//     (actual_value / actual_date) come ONLY from PPT / Prowess. Enforced in prompt.
//
// VOCABULARY CASING — NO LONGER SCHEMA-ENFORCED:
//   Because the classification fields are open, the schema cannot guarantee
//   casing the way an enum did. To avoid the prior BEAT-vs-beat / FY25_END-vs-ISO
//   class of bug re-appearing, NORMALIZE these fields downstream (lowercase +
//   snake) before anything switches or aggregates on them. In particular,
//   signal `direction` (beat/miss/in_line/...) feeds SCORE & STATUS DERIVATION in
//   lens-bridge.md — a free-text variant that misses string-match silently
//   skews the score, so normalize it before scoring.
//
// DATE FORMAT — CANONICAL (unchanged):
//   Every *_date is strict ISO 8601 (YYYY-MM-DD), resolved to the LAST DAY of the
//   implied period (e.g. FY2027 -> "2027-03-31", FY2026 Q3 -> "2025-12-31").
//   Free-text period labels ("FY25_END", "Q3_FY26") are FORBIDDEN. String-equal
//   period matching depends on this; a free-text label silently breaks matching.
// =============================================================================

// --- SHARED SUPERSET CHILD ---------------------------------------------------
// One schema for BOTH top_signals[] and patterns[] children.
// Fields fall into three bands:
//   A) Identity / classification — always meaningful.
//   B) Guidance-track-record band — meaningful for top_signals guidance rows.
//   C) Pattern band — meaningful for patterns[] children.
// The schema keeps every field required-or-null. The PROMPT decides which band
// must be non-null for a given child, by type. See lens-bridge.md "FIELD BANDS".
//
// Open-vocab note: `direction`, `impact`, `pattern_type` are open strings; their
// suggested vocabularies are in their `description`s and are NOT enforced.
const childItem = {
  type:                 'object',
  additionalProperties: false,
  required: [
    // -- A. Identity / classification --
    'kind',              // 'signal' | 'pattern' — which array this child belongs to
    'signal_id',
    'metric',
    'label',
    'impact',
    'direction',
    'statement',
    'original_statement',
    'source_ref',        // traceability (page / timestamp / PPT slide / API call)

    // -- B. Guidance track record band (top_signals) --
    'announcement_date',
    'value_targeted',
    'value_targeted_low',
    'value_targeted_high',
    'target_date',
    'actual_value',
    'actual_date',
    'unit',

    // -- C. Pattern band (patterns) --
    'pattern_type',
    'confidence',
    'confidence_reason',
    'sentence',
    'shape_data',
    'shape_label',
    'evidence',
  ],
  properties: {
    // -- A. Identity / classification --
    // KEPT ENUM: structural discriminator, not an analytic field. The two-array
    // contract and the field bands route on this. 'signal' => guidance-track-record
    // child; 'pattern' => behavioral child.
    kind:               { type: 'string', enum: ['signal', 'pattern'] },
    signal_id:          { type: 'string' }, // "" when no single source signal
    metric:             { type: 'string' }, // "" for pure patterns without a single metric
    label:              { type: 'string' }, // 2-5 words, title-case

    // OPEN. Suggested values: high | medium | low. These are suggestions, not a
    // closed set — use them when they fit, otherwise use the most accurate label.
    impact: {
      type: 'string',
      description:
        'Materiality of this child. Suggested values: "high", "medium", "low". ' +
        'Suggestions, not a closed set.',
    },

    // OPEN, and OVERLOADED by `kind`. Suggested vocabularies differ per kind:
    //   kind=signal  (guidance hit vs guided): beat | miss | in_line | unresolvable | none
    //   kind=pattern (behavioral sentiment):   positive | negative | neutral | watch
    // Suggestions only. Resolve signal direction by comparing actual vs guided,
    // never by subtraction. NOTE: signal direction feeds score derivation —
    // normalize downstream before scoring.
    direction: {
      type: 'string',
      description:
        'Directionality. Suggested values depend on `kind`. ' +
        'For kind="signal" (guidance outcome vs the guided value): "beat", "miss", ' +
        '"in_line", "unresolvable", "none". ' +
        'For kind="pattern" (behavioral sentiment): "positive", "negative", ' +
        '"neutral", "watch". ' +
        'These are suggestions, not a closed set; prefer them when they fit. ' +
        'Resolve signal direction by comparing actual vs guided (never by subtraction).',
    },

    // VERBATIM evidence excerpt, <= 80 chars. "" if none.
    statement:          { type: 'string' },
    // Exact verbatim source sentence this child was extracted from. "" if none.
    original_statement: { type: 'string' },
    // Traceability anchor: page no. / call timestamp / PPT slide / Prowess call id. "" if unavailable.
    source_ref:         { type: 'string' },

    // -- B. Guidance track record band (kind='signal') --
    announcement_date:   { type: 'string' }, // ISO YYYY-MM-DD; "" when not applicable
    value_targeted:      { type: 'number' }, // single-point commitment; -1 when not applicable
    value_targeted_low:  { type: 'number' }, // range low; -1 when not applicable
    value_targeted_high: { type: 'number' }, // range high; -1 when not applicable
    target_date:         { type: 'string' }, // ISO YYYY-MM-DD last-day-of-period; "" when not applicable
    actual_value:        { type: 'number' }, // verbatim from PPT/Prowess; -1 when not applicable
    actual_date:         { type: 'string' }, // ISO YYYY-MM-DD last-day-of-period; "" when not applicable
    // OPEN. Common values: Cr | % | x | bps. "" when not applicable.
    unit: {
      type: 'string',
      description:
        'Unit of the targeted/actual values. Common values: "Cr", "%", "x", "bps". ' +
        'Open string — use the unit that applies. "" when not applicable.',
    },

    // -- C. Pattern band (kind='pattern') --
    // OPEN. Suggested taxonomy below — extend with your own label when none fit.
    // For kind='signal' use "none" or "".
    pattern_type: {
      type: 'string',
      description:
        'Behavioral pattern type. Suggested taxonomy (coin a new label when none ' +
        'fit): "drumbeat" (theme gaining/losing emphasis across quarters), ' +
        '"emergence" (new initiative/risk first-appearing then accelerating), ' +
        '"narrative_gap" (mgmt emphasis vs analyst question-density gap), ' +
        '"tone_divergence" (bullish tone vs decelerating KPI), ' +
        '"going_quiet" (topic once promoted, now barely mentioned), ' +
        '"street_pressure" (analyst question clustering). ' +
        'These are suggestions, not a closed set. For kind="signal" use "none" or "".',
    },
    // 0.0-1.0 evidence strength for included patterns; -1 for kind='signal'.
    confidence:         { type: 'number' },
    confidence_reason:  { type: 'string' }, // "" for kind='signal'
    sentence:           { type: 'string' }, // full one-line causal claim; "" for kind='signal'
    // JSON-stringified shape array (kept as string to avoid schema explosion). "" if none.
    shape_data:         { type: 'string' },
    shape_label:        { type: 'string' }, // "" if none
    // Tap-to-verify evidence. [] for kind='signal'.
    evidence: {
      type:  'array',
      items: {
        type:                 'object',
        additionalProperties: false,
        required: ['period', 'signal_id', 'value', 'quote'],
        properties: {
          period:    { type: 'string' }, // ISO date or ISO-resolved period
          signal_id: { type: 'string' }, // traceability to L1 signal
          value:     { type: 'number' }, // mention count; -1 if not applicable
          quote:     { type: 'string' }, // VERBATIM management text
        },
      },
    },
  },
};

// --- ROOT LENS OUTPUT SCHEMA -------------------------------------------------
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
        // score: integer 0-100. Derivation is DEFINED in lens-bridge.md
        // ("SCORE & STATUS DERIVATION"). Deterministic from hit rate + adjustments.
        score:       { type: 'integer' },
        // status: KEPT ENUM — a computed bucket of `score`, not an analysis field.
        // STRONG >= 70, MODERATE 40-69, WEAK < 40.
        status:      { type: 'string', enum: ['STRONG', 'MODERATE', 'WEAK'] },
        // takeaway: max 30 words (canonical; supersedes v5's 250-300 char rule).
        takeaway:    { type: 'string' },
        key_metrics: {
          type:                 'object',
          additionalProperties: { type: 'string' },
        },
        highlights: { type: 'array', items: { type: 'string' } }, // up to 3, <=12 words each
        risks:      { type: 'array', items: { type: 'string' } }, // up to 2, <=12 words each

        // Guidance track record children. Each item has kind='signal'.
        top_signals: { type: 'array', items: childItem },

        // Behavioral pattern children. Each item has kind='pattern'.
        // Management lenses emit patterns; non-management lenses emit [].
        patterns:    { type: 'array', items: childItem },
      },
    },
  },
};

module.exports = { lensOutputSchema, childItem };