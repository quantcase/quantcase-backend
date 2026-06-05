'use strict';

const overviewOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'overview',
    strict: false,
    schema: {
      type: 'object',
      required: ['score', 'verdict', 'verdict_band', 'conviction', 'headline', 'subtitle', 'snapshot', 'technical_summary', 'dimensions', 'key_signals', 'signal_map', 'thesis', 'evidence', 'watch_outs', 'action_bias', 'technical_regime', 'ideal_for', 'timeframe', 'ic_metrics'],
      properties: {
        score: {
          type:        'integer',
          description: 'Composite 0–100. Weighted: opportunity 40%, management 30%, deal 30%. Redistribute proportionally if a dimension is missing.',
        },
        verdict: {
          type: 'string',
          enum: ['STRONG', 'MODERATE', 'WEAK', 'CAUTIOUS'],
        },
        verdict_band: {
          type:        'string',
          enum:        ['STRONG BUY', 'MODERATE BAND', 'CAUTIOUS HOLD', 'WEAK / AVOID'],
          description: '≥80 → STRONG BUY; 60–79 → MODERATE BAND; 40–59 → CAUTIOUS HOLD; <40 → WEAK / AVOID.',
        },
        conviction: {
          type:        'string',
          enum:        ['HIGH', 'MEDIUM', 'LOW'],
          description: 'HIGH if all three fundamentals agree; MEDIUM if two agree; LOW if all diverge.',
        },
        headline: {
          type:        'string',
          description: '≤8 words — punchy overall thesis. Italicise 1–2 key terms with *single asterisks*. GOOD: "*Execution* risk offsets strong headline growth". BAD: "Strong headline growth with *structural* tailwinds and execution headwinds" (10w).',
        },
        subtitle: {
          type:        'string',
          description: '≤10 words — timing or risk qualifier. GOOD: "Wait for greenfields ramp confirmation". BAD: "Greenfields ramp delays are offset by fortress balance sheet strength" (11w).',
        },
        snapshot: {
          type:        'string',
          description: 'ABOUT section — single paragraph, 4–5 sentences MAX. Cover: what the company does → its moat → the key growth driver → the main risk → what investor fits it. Each sentence ≤25 words. Bold 2–4 key phrases with **double asterisks**. Never bold a full sentence.',
        },
        technical_summary: {
          type:        'string',
          description: 'EXACTLY 4 short lines separated by \\n. Each line ≤15 words. No indicator names (SMA/RSI/ADX/CMF/BB/Wyckoff/CRS/MACD forbidden). Line 1: price position + money flow direction. Line 2: trend strength. Line 3: relative performance vs market. Line 4: what to watch or do next. Bold the single most important phrase per line with **double asterisks**. If technicals data is unavailable, write "Technical analysis data unavailable." on line 1 and fill lines 2–4 accordingly.',
        },
        dimensions: {
          type:        'array',
          description: 'One entry per source type present (management, opportunity, deal, technicals), in that order. Omit a dimension only if its data was marked "Not available".',
          items: {
            type:     'object',
            required: ['type', 'score', 'weight', 'verdict', 'verdict_band', 'headline', 'contribution'],
            properties: {
              type:         { type: 'string', enum: ['management', 'opportunity', 'deal', 'technicals'] },
              score:        { type: ['integer', 'null'], description: 'Taken directly from source — null if unavailable.' },
              weight:       { type: 'integer', description: 'management=30, opportunity=40, deal=30, technicals=0 (informational only).' },
              verdict:      { type: ['string', 'null'], description: 'Taken directly from source — null if unavailable.' },
              verdict_band: { type: ['string', 'null'], description: 'Taken directly from source — null if unavailable.' },
              headline:     { type: 'string', description: '≤8 words — taken from source but SHORTEN if over 8 words.' },
              contribution: { type: 'integer', description: 'Math.round(score * weight / 100). Use 0 if weight=0 or score is null.' },
            },
          },
        },
        key_signals: {
          type:        'array',
          description: 'Exactly 2–4 pills — the single most critical positive and negative data points.',
          items: {
            type:     'object',
            required: ['label', 'sentiment'],
            properties: {
              label:     { type: 'string', description: 'MAX 5 words. Count every word.' },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            },
          },
        },
        signal_map: {
          type:        'array',
          description: 'Exactly 6–8 entries. Pick the most diagnostic signals across all dimensions.',
          items: {
            type:     'object',
            required: ['category', 'signal', 'summary', 'sentiment'],
            properties: {
              category:  { type: 'string', description: '≤3 words ALL CAPS — e.g. "ASSET QUALITY", "MARGIN RISK", "CORE GROWTH".' },
              signal:    { type: 'string', description: 'HARD LIMIT ≤7 words.' },
              summary:   { type: 'string', description: '1–3 words — tile value distinct from category.' },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            },
          },
        },
        thesis: {
          type:        'string',
          description: 'EXACTLY 3 sentences. Each standalone, ≤20 words, ending in ".". Bold 1 phrase per sentence with **double asterisks**. GOOD: "**Strong headline growth** masks weak core. **Execution risk** is the key watchout. Wait for **capacity absorption** before building conviction." BAD: one long run-on paragraph.',
        },
        evidence: {
          type:        'array',
          description: '3–5 strings — HARD LIMIT ≤8 words each. Bold the key metric or number with **double asterisks**.',
          items: { type: 'string' },
        },
        watch_outs: {
          type:        'array',
          description: '2–4 strings — HARD LIMIT ≤7 words each. Bold the core risk term with **double asterisks**.',
          items: { type: 'string' },
        },
        action_bias: {
          type:        ['string', 'null'],
          description: 'Taken from technicals actionBias — null if technicals unavailable.',
        },
        technical_regime: {
          type:        ['string', 'null'],
          description: '≤8 words — taken from technicals currentRegime.label, shorten if needed. null if technicals unavailable.',
        },
        ideal_for: {
          anyOf:       [{ type: 'string', enum: ['Investment', 'Swing', 'Positional'] }, { type: 'null' }],
          description: 'From technicals — null if unavailable.',
        },
        timeframe: {
          anyOf:       [{ type: 'string', enum: ['6M+', '3-6M', '0-3M'] }, { type: 'null' }],
          description: 'From technicals — null if unavailable.',
        },
        ic_metrics: {
          type:        'array',
          description: 'EXACTLY 4 items in this order: entry_trigger, suggested_stop, upside_target, time_horizon.',
          items: {
            type:     'object',
            required: ['category', 'title', 'value', 'label', 'description', 'status'],
            properties: {
              category:    { type: 'string', enum: ['entry_trigger', 'suggested_stop', 'upside_target', 'time_horizon'] },
              title:       { type: 'string', description: 'Display label, e.g. "Entry Trigger", "Suggested Stop", "Upside Target", "Time Horizon".' },
              value:       { type: 'string', description: 'Primary numeric or text value, e.g. "₹3121–₹3547", "-23%", "+36%", "0-3M".' },
              label:       { type: 'string', description: '≤5 words — secondary qualifier, e.g. "On 50-level reclaim", "Below key support".' },
              description: { type: 'string', description: 'HARD LIMIT ≤12 words. Bold 1 key number or phrase with **double asterisks**.' },
              status:      { type: 'string', enum: ['active', 'pending', 'avoid'], description: '"active" if condition is currently met; "pending" if waiting for trigger; "avoid" if action_bias is Avoid.' },
            },
          },
        },
      },
    },
  },
};

module.exports = { overviewOutputSchema };
