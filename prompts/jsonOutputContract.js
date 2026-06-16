'use strict';

// JSON Output Contract — appended after the client's analytical skill doc.
// Maps the doc's analysis sections to the exact JSON schema fields the API expects.
// Injected by lensComposer when lensConfig.config.bridge_prompt === true.

const JSON_OUTPUT_CONTRACT = `
---

## JSON Output Contract

After completing the analysis above, return your findings as a single JSON object with this exact structure. All field names are fixed — do not rename or add keys.

**direction values for top_signals:** beat | in_line | miss | promise_silently_dropped | major_miss | tracking | null
**direction values for patterns:** positive | negative | neutral | watch
**shape_data** must be a string containing valid JSON — use JSON.stringify format, not a raw object.
Any field you cannot populate with real data must be null — never use 0, "", or "undefined" as a placeholder.
patterns must always contain exactly 6 objects in this order: drumbeat, emergence, narrative_gap, tone_divergence, going_quiet, street_pressure.
Patterns with no evidence: set confidence to 0.0, explain in confidence_reason, and start sentence with "Insufficient data:".

\`\`\`json
{
  "score": <integer 0–100, overall management credibility score>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string, max 25 words — lead with hit rate fraction and bias label, e.g. "6/9 resolved; Conservative bias — revenue beats dominate, capex guidance unreliable.">,
  "key_metrics": {},
  "highlights": [<up to 3 strings from "What Management Delivers On" — max 15 words each, start with metric or verb, include numbers>],
  "risks": [<up to 2 strings from "What Management Slips On" — max 12 words each, start with risk noun, include numbers>],

  "top_signals": [

    // Position 0 — Hit Rate Summary (from "Hit Rate Summary" section)
    {
      "signal_id": null,
      "metric": "HEADLINE_HIT_RATE",
      "label": "<X/Y fraction, e.g. '13/18'>",
      "statement": "<one sentence: which metrics hit and which missed, max 80 chars>",
      "actual_value": <X — beat + in_line count>,
      "value_targeted": <Y — total resolved>,
      "guided_value": null, "guided_date": null,
      "unit": "ratio",
      "direction": "beat",
      "impact": "high",
      "announcement_date": null, "value_at_announcement": null,
      "target_date": null, "actual_date": null,
      "delta": null, "delta_pct": null, "original_statement": null
    },

    // Position 1 — Biggest resolved miss (from "What Management Slips On")
    {
      "signal_id": "<id from DATA_BLOCK>",
      "metric": "HEADLINE_MAJOR_MISS",
      "label": "<metric name + delta, e.g. 'EBITDA Margin -160bps'>",
      "statement": "Targeted [X] for [period] (announced [Q]) — came in at [Y], shortfall of [Z].",
      "actual_value": <actual of the missed metric>,
      "value_targeted": <guided value>,
      "guided_value": null, "guided_date": null,
      "unit": "<%, Cr, bps, etc.>",
      "direction": "major_miss",
      "impact": "high",
      "announcement_date": "<e.g. 'Q2 FY24'>",
      "value_at_announcement": null,
      "target_date": "<ISO 8601 last day of target period>",
      "actual_date": "<ISO 8601 last day of reported period>",
      "delta": <actual_value minus value_targeted>,
      "delta_pct": <delta / value_targeted * 100, 1dp>,
      "original_statement": "<verbatim quote from DATA_BLOCK>"
    },
    // If no material miss: label = "No Major Miss", actual_value = 0, direction = "beat", other nulls as above

    // Position 2 — Guidance Bias (from overall hit/miss pattern)
    {
      "signal_id": null,
      "metric": "HEADLINE_GUIDANCE_BIAS",
      "label": "<'Conservative' | 'Balanced' | 'Mixed' | 'Aggressive'>",
      "statement": "<beat/miss count split justifying the label, max 80 chars>",
      "actual_value": null, "value_targeted": null,
      "guided_value": null, "guided_date": null,
      "unit": null, "delta": null, "delta_pct": null,
      "direction": null, "impact": "high",
      "announcement_date": null, "value_at_announcement": null,
      "target_date": null, "actual_date": null, "original_statement": null
    },

    // Positions 3–22 — Guidance Track Record rows (one per row of the Track Record Table, max 20)
    // Each row maps directly to one table row:
    //   Announcement Date  → announcement_date   (e.g. "Q2 FY24")
    //   Guided Metric      → metric              (e.g. "EBITDA_MARGIN", "REVENUE", "CAPEX")
    //   Guided Value       → value_targeted      (numeric, unit-standardised; null for binary milestones)
    //   Target Date        → target_date         (ISO 8601 last day, e.g. "2026-03-31" for FY26)
    //   Actual Value       → actual_value        (numeric; null if not yet reported)
    //   Hit Status         → direction           (beat | in_line | miss | promise_silently_dropped | tracking)
    //   Management Statement → original_statement (verbatim quote, 50–80 chars)
    {
      "signal_id": "<id from DATA_BLOCK>",
      "metric": "<e.g. 'REVENUE', 'EBITDA_MARGIN', 'CAPEX', 'STORE_COUNT'>",
      "label": "<target period, max 10 chars, e.g. 'FY26' or 'Q3 FY26'>",
      "statement": "<'[Metric] targeted at [X] by [period] (announced [Q]) — [period] came in at [Y].' OR end with '— [period] result not yet reported.' Max 100 chars. Revised commitments start with 'Revised guidance:'>",
      "announcement_date": "<e.g. 'Q2 FY24'>",
      "value_at_announcement": <metric value when management spoke — null if unavailable>,
      "value_targeted": <numeric guided value — null for binary milestones with no number>,
      "guided_value": null, "guided_date": null,
      "target_date": "<ISO 8601 last day of target period>",
      "actual_value": <reported result for exact target period — null if not yet reported>,
      "actual_date": "<ISO 8601 last day of reported period — null if not yet reported>",
      "unit": "<'%' | 'Cr' | 'bps' | 'x' | 'million' | 'stores' | 'timing' — null if none>",
      "delta": <actual_value minus value_targeted — null if either side absent>,
      "delta_pct": <delta / value_targeted * 100 rounded to 1dp — null if delta absent>,
      "direction": "<beat | in_line | miss | promise_silently_dropped | tracking>",
      "impact": "<'high' | 'medium' | 'low'>",
      "original_statement": "<verbatim sentence from DATA_BLOCK — null if none>"
    },

    // Last position — Entry count summary
    {
      "signal_id": null,
      "metric": "HEADLINE_ENTRY_COUNT",
      "label": "<'N entries' where N = count of track record rows emitted>",
      "statement": "<timeline span, e.g. 'Q3 FY22 → FY27 — 5 years of commitments', max 60 chars>",
      "actual_value": null, "value_targeted": null,
      "guided_value": null, "guided_date": null,
      "unit": null, "delta": null, "delta_pct": null,
      "direction": null, "impact": "high",
      "announcement_date": null, "value_at_announcement": null,
      "target_date": null, "actual_date": null, "original_statement": null
    }

  ],

  "patterns": [

    // Pattern 1 — Drumbeat (from "Drumbeat" section above)
    {
      "type": "drumbeat",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<e.g. '4 quarters of mgmt_tone signals with frequency data' or 'no mgmt_tone signals available'>",
      "label": "<3–6 word title, e.g. 'Data Centre Capex Drumbeat'>",
      "sentence": "<one-liner leading with the delta, e.g. 'Capex theme 1x Q1 FY25, rising to 12x Q4 FY26 — signals strategic pivot.'>",
      "shape_label": "<e.g. 'Mention frequency Q1 FY25 to Q4 FY26'>",
      "shape_data": "<JSON.stringify([{\"period\":\"Q1 FY25\",\"value\":1},{\"period\":\"Q4 FY26\",\"value\":12}])>",
      "evidence": [
        { "period": "<quarter>", "signal_id": "<id or null>", "value": <mention count or null>, "quote": "<verbatim or null>" }
      ],
      "direction": "<'positive' | 'negative' | 'neutral' | 'watch'>",
      "impact": "<'high' | 'medium' | 'low'>"
    },

    // Pattern 2 — Emergence
    // shape_data: [{"period":"Q1 FY25","value":0},{"period":"Q3 FY25","value":1},{"period":"Q1 FY26","value":8}]
    // Include at least one pre-emergence entry (value: 0, quote: null) and the emergence quarter
    {
      "type": "emergence",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<reason>",
      "label": "<e.g. 'AI Infra Demand Emergence'>",
      "sentence": "<e.g. 'AI infra demand first mentioned Q3 FY25; surged to 8x by Q1 FY26 — category pivot underway.'>",
      "shape_label": "<e.g. 'First emergence Q3 FY25, acceleration Q1 FY26 onwards'>",
      "shape_data": "<JSON.stringify([{\"period\":\"Q1 FY25\",\"value\":0},{\"period\":\"Q3 FY25\",\"value\":1},{\"period\":\"Q1 FY26\",\"value\":8}])>",
      "evidence": [
        { "period": "<pre-emergence quarter>", "signal_id": null, "value": 0, "quote": null },
        { "period": "<emergence quarter>", "signal_id": "<id>", "value": 1, "quote": "<first mention verbatim>" },
        { "period": "<acceleration quarter>", "signal_id": "<id>", "value": 8, "quote": "<quote>" }
      ],
      "direction": "<'positive' | 'negative' | 'watch'>",
      "impact": "<'high' | 'medium' | 'low'>"
    },

    // Pattern 3 — Narrative vs Consensus Gap
    // shape_data: [{"label":"Management","value":35},{"label":"Analysts","value":5}]
    // value = % of total commentary / total analyst questions respectively
    {
      "type": "narrative_gap",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<reason>",
      "label": "<e.g. 'Supply Chain Resilience Gap'>",
      "sentence": "<e.g. 'Supply chain: 35% of management narrative vs 5% of analyst questions — Street asleep on risk.'>",
      "shape_label": "<e.g. 'Management vs Analyst emphasis — Q4 FY26 call'>",
      "shape_data": "<JSON.stringify([{\"label\":\"Management\",\"value\":35},{\"label\":\"Analysts\",\"value\":5}])>",
      "evidence": [
        { "period": "<call quarter>", "signal_id": "<id or null>", "value": <management ref count>, "quote": "<management quote>" },
        { "period": "<call quarter>", "signal_id": "<id or null>", "value": <analyst Q count>, "quote": "<analyst question sample>" }
      ],
      "direction": "<'positive' | 'negative' | 'watch'>",
      "impact": "<'high' | 'medium' | 'low'>"
    },

    // Pattern 4 — Tone vs Numbers Divergence
    // shape_data: [{"period":"Q1 FY26","tone_score":1,"kpi_value":24},{"period":"Q4 FY26","tone_score":1,"kpi_value":18}]
    // tone_score: 1=bullish, 0=neutral, -1=cautious
    {
      "type": "tone_divergence",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<reason>",
      "label": "<e.g. 'Margin Narrative Inflation'>",
      "sentence": "<e.g. 'Bullish tone through Q4 FY26 while revenue growth fell 24% to 18% — narrative inflation signal.'>",
      "shape_label": "<e.g. 'Management tone vs Revenue Growth Q1–Q4 FY26'>",
      "shape_data": "<JSON.stringify([{\"period\":\"Q1 FY26\",\"tone_score\":1,\"kpi_value\":24},{\"period\":\"Q4 FY26\",\"tone_score\":1,\"kpi_value\":18}])>",
      "evidence": [
        { "period": "<earliest quarter>", "signal_id": "<id or null>", "value": <kpi_value>, "quote": "<bullish tone quote>" },
        { "period": "<latest quarter>", "signal_id": "<id or null>", "value": <kpi_value>, "quote": "<tone quote at latest period>" }
      ],
      "direction": "negative",
      "impact": "<'high' | 'medium' | 'low'>"
    },

    // Pattern 5 — Going Quiet
    // shape_data: [{"period":"Q1 FY25","value":8},{"period":"Q4 FY26","value":0}]
    {
      "type": "going_quiet",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<reason>",
      "label": "<e.g. 'Premium Segment Silence'>",
      "sentence": "<e.g. 'Premium segment 8x in Q1 FY25, zero mentions by Q3 FY26 — likely profit miss incoming.'>",
      "shape_label": "<e.g. 'Mention frequency — Premium Segment'>",
      "shape_data": "<JSON.stringify([{\"period\":\"Q1 FY25\",\"value\":8},{\"period\":\"Q2 FY25\",\"value\":5},{\"period\":\"Q4 FY26\",\"value\":0}])>",
      "evidence": [
        { "period": "<peak quarter>", "signal_id": "<id or null>", "value": <peak count>, "quote": "<peak quote>" },
        { "period": "<last mention quarter>", "signal_id": "<id or null>", "value": <last count>, "quote": "<last mention>" },
        { "period": "<silent quarter>", "signal_id": null, "value": 0, "quote": null }
      ],
      "direction": "negative",
      "impact": "<'high' | 'medium' | 'low'>"
    },

    // Pattern 6 — Street Pressure Map
    // shape_data: sorted descending by value — [{"label":"Capex plans","value":28},{"label":"Working capital","value":22}]
    {
      "type": "street_pressure",
      "confidence": <0.0–1.0>,
      "confidence_reason": "<reason>",
      "label": "<e.g. 'Capex Dominates Q4 FY26'>",
      "sentence": "<e.g. 'Capex: 28 analyst Qs (21%); margin expansion: only 2 Qs — potential upside under-researched.'>",
      "shape_label": "<e.g. 'Analyst question clusters — Q4 FY26 call (132 total Qs)'>",
      "shape_data": "<JSON.stringify([{\"label\":\"Capex plans\",\"value\":28},{\"label\":\"Working capital\",\"value\":22},{\"label\":\"Volume growth\",\"value\":18}])>",
      "evidence": [
        { "period": "<call quarter>", "signal_id": "<id or null>", "value": <total Q count>, "quote": "<top cluster summary>" },
        { "period": "<call quarter>", "signal_id": "<id or null>", "value": <gap topic Q count>, "quote": "<gap insight>" }
      ],
      "direction": "watch",
      "impact": "<'high' | 'medium' | 'low'>"
    }

  ]
}
\`\`\`
`;

module.exports = { JSON_OUTPUT_CONTRACT };
