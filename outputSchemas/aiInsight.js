'use strict';

const aiInsightOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'ai_insight',
    strict: false,
    schema: {
      type: 'object',
      required: ['score', 'verdict', 'verdict_band', 'headline', 'subtitle', 'description', 'key_signals', 'lenses', 'signal_map', 'thesis', 'evidence', 'watch_outs'],
      properties: {
        score: {
          type:        'integer',
          description: 'Overall composite score 0–100. Weighted average of (lens.score / lens.max_score) × 100 across all lenses.',
        },
        verdict: {
          type:        'string',
          enum:        ['STRONG', 'MODERATE', 'WEAK', 'CAUTIOUS'],
        },
        verdict_band: {
          type:        'string',
          enum:        ['STRONG BUY', 'MODERATE BAND', 'CAUTIOUS HOLD', 'WEAK / AVOID'],
          description: 'Derived from score: ≥80 → STRONG BUY; 60–79 → MODERATE BAND; 40–59 → CAUTIOUS HOLD; <40 → WEAK / AVOID.',
        },
        headline: {
          type:        'string',
          description: '≤8 words — punchy thesis. Italicise 1–2 key terms with *single asterisks*. GOOD: "*Execution* headwinds on core growth" (5w). BAD: "Scaled growth with *structural* tailwinds and fortress balance sheet" (9w).',
        },
        subtitle: {
          type:        'string',
          description: '≤10 words — single action or timing qualifier. Italicise the single most important term with *single asterisks*. GOOD: "Watch *greenfields* ramp before adding" (5w). BAD: "Greenfields ramp delays are offset by fortress balance sheet strength" (11w).',
        },
        description: {
          type:        'string',
          description: '2 short sentences MAX — each ≤20 words. Bold 1–2 key phrases per sentence with **double asterisks**. GOOD: "MSWIL posts **25.5% YoY revenue growth** with **fortress balance sheet**, but organic growth slumps to 1%." BAD: plain text with no highlights.',
        },
        key_signals: {
          type:        'array',
          description: 'Exactly 2–4 pills — the single most critical positive and negative data points.',
          items: {
            type:     'object',
            required: ['label', 'sentiment'],
            properties: {
              label: {
                type:        'string',
                description: 'HARD LIMIT ≤5 words. COUNT them. GOOD: "Core growth only +1%" (4w). BAD: "Core ex-greenfields growth collapsed to just +1% YoY" (9w).',
              },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            },
          },
        },
        lenses: {
          type:        'array',
          description: 'One entry per input lens, same order as input. max_score values must sum to 100; each lens gets between 15 and 45.',
          items: {
            type:     'object',
            required: ['slug', 'name', 'score', 'max_score', 'status', 'subtitle', 'description'],
            properties: {
              slug:      { type: 'string' },
              name:      { type: 'string' },
              score: {
                type:        'integer',
                description: 'Scale 0–100 lens score proportionally to max_score.',
              },
              max_score: {
                type:        'integer',
                description: 'Allocate total 100 pts across lenses proportional to their weight; each lens gets between 15 and 45.',
              },
              status:   { type: 'string', enum: ['STRONG', 'MODERATE', 'NEUTRAL', 'MIXED', 'WEAK', 'REACTIVE', 'DISCIPLINED', 'STABLE'] },
              subtitle: {
                type:        'string',
                description: '≤5 words ALL CAPS — punchy thematic label. e.g. "BEATS ON CREDIT", "EXECUTION RISK", "FORTRESS BALANCE SHEET".',
              },
              description: {
                type:        'string',
                description: '1 sentence only ≤20 words — the single most important finding for this lens. Bold the key number or finding with **double asterisks**.',
              },
            },
          },
        },
        signal_map: {
          type:        'array',
          description: 'EXACTLY 8 signals — no more, no fewer. Pick the 8 most diagnostic ones across all lenses.',
          items: {
            type:     'object',
            required: ['category', 'signal', 'summary', 'sentiment'],
            properties: {
              category: {
                type:        'string',
                description: '≤3 words ALL CAPS — e.g. "ASSET QUALITY", "MARGIN RISK", "CORE GROWTH".',
              },
              signal: {
                type:        'string',
                description: 'HARD LIMIT ≤7 words. COUNT them. GOOD: "Core ex-greenfields at +1% YoY" (6w). BAD: "Greenfields ramp delays acknowledged; capacity absorption tracking needed" (8w).',
              },
              summary: {
                type:        'string',
                description: '1–3 words — tile value distinct from category. GOOD: "Strong YoY", "Margin squeeze", "+1% organic". NOT a repeat of category.',
              },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            },
          },
        },
        thesis: {
          type:        'string',
          description: 'EXACTLY 2–3 sentences, each ≤30 words. NOT a paragraph — separate distinct sentences. Bold 1 key phrase per sentence with **double asterisks**. GOOD: "**Strong headline growth** masks weak core at +1% ex-greenfields. **Execution risk** on capacity absorption is the key watchout." BAD: one 80-word run-on paragraph.',
        },
        evidence: {
          type:        'array',
          description: '3–4 strings — HARD LIMIT ≤10 words each. Bold the key metric or number with **double asterisks**. GOOD: "**Ex-greenfields EBITDA** grew 7.6% stable margin" (7w). BAD: plain text without highlights.',
          items: { type: 'string' },
        },
        watch_outs: {
          type:        'array',
          description: '2–3 strings — HARD LIMIT ≤8 words each. Bold the core risk term with **double asterisks**. GOOD: "**Greenfields ramp** delay compresses margins" (5w). BAD: plain text without highlights.',
          items: { type: 'string' },
        },
      },
    },
  },
};

module.exports = { aiInsightOutputSchema };
