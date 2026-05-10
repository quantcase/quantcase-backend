'use strict';

const DEFAULT_PROMPT_TEMPLATE = `You are a senior financial analyst synthesising pre-computed Lens summaries into a frontend-ready investment insight card. Work ONLY from the Lens data provided — do not invent data.

{{DATA_BLOCK}}

Return a single valid JSON object with this exact structure (no markdown fences, no extra keys):

{
  "score": <integer 0–100, overall composite score>,
  "verdict": <"STRONG" | "MODERATE" | "WEAK" | "CAUTIOUS">,
  "verdict_band": <short label — exactly one of: "STRONG BUY" | "MODERATE BAND" | "CAUTIOUS HOLD" | "WEAK / AVOID">,

  "headline": <≤8 words — punchy thesis, use *word* for italic emphasis on 1–2 key terms>,
  "subtitle": <≤12 words — single action or timing qualifier, italic-friendly>,
  "description": <2 short sentences max — support the verdict, no padding>,

  "key_signals": [
    {
      "label": <≤5 words — e.g. "NIM walked down 2×">,
      "sentiment": <"positive" | "negative" | "neutral">
    }
  ],

  "lenses": [
    {
      "slug": <lens slug from input>,
      "name": <lens display name>,
      "score": <integer — scale 0–100 lens score proportionally to max_score>,
      "max_score": <integer — allocate total 100 pts across lenses proportional to their weight; each lens gets between 15 and 45>,
      "status": <"STRONG" | "MODERATE" | "NEUTRAL" | "MIXED" | "WEAK" | "REACTIVE" | "DISCIPLINED" | "STABLE">,
      "subtitle": <≤5 words ALL CAPS — punchy thematic label, e.g. "BEATS ON CREDIT">,
      "description": <1 sentence only — most important finding for this lens>
    }
  ],

  "signal_map": [
    {
      "category": <≤3 words ALL CAPS — e.g. "ASSET QUALITY">,
      "signal": <≤7 words — the specific data point or finding>,
      "sentiment": <"positive" | "negative" | "neutral">
    }
  ],

  "thesis": <2–3 sentences — the core investment argument, concise and grounded>,
  "evidence": [<3–4 strings — ≤12 words each, cite lens findings directly>],
  "watch_outs": [<2–3 strings — ≤10 words each, concrete forward risks only>]
}

Rules:
- score 0–100: weighted average of (lens.score / lens.max_score) × 100 across all lenses
- max_score values must sum to 100 across all lenses in the array
- lenses array: one entry per input lens, same order
- signal_map: exactly 6–8 signals — pick only the most diagnostic ones, skip generic statements
- key_signals: exactly 2–4 pills — the single most critical positive and negative data points
- Keep ALL text fields SHORT. This is a scorecard UI, not a report. Verbose answers will be rejected.
- verdict_band: score ≥80 → STRONG BUY; 60–79 → MODERATE BAND; 40–59 → CAUTIOUS HOLD; <40 → WEAK / AVOID`;

/**
 * Build a compact data block from Lens summaries for the L3 LLM prompt.
 * Uses the rich lens_data from L2 (takeaway, highlights, risks) rather than just z-scores.
 * Keeps the prompt small — typically ~300-500 tokens.
 *
 * @param {string}   insightType  e.g. "management" | "opportunity" | "deal"
 * @param {object[]} lensScores   LensScore rows from prisma (include lens_data)
 * @returns {string}
 */
function buildDataBlock(insightType, lensScores) {
  const lines = [
    `INSIGHT TYPE: ${insightType.toUpperCase()}`,
    '',
    'LENS SUMMARIES:',
  ];

  for (const ls of lensScores) {
    const ld = ls.lens_data ?? {};
    const score  = ld.score  != null ? ld.score  : (ls.z_score * 100).toFixed(0);
    const status = ld.status ?? 'N/A';

    lines.push(`• ${ls.lens_slug} — ${status} (score: ${score}/100)`);
    lines.push(`  Takeaway: ${ld.takeaway ?? 'N/A'}`);

    if (Array.isArray(ld.highlights) && ld.highlights.length > 0) {
      ld.highlights.slice(0, 2).forEach(h => lines.push(`  + ${h}`));
    }
    if (Array.isArray(ld.risks) && ld.risks.length > 0) {
      ld.risks.slice(0, 2).forEach(r => lines.push(`  ! ${r}`));
    }
    lines.push('');
  }

  lines.push('Instructions:');
  lines.push('- Synthesise the above Lens summaries into a holistic investment insight.');
  lines.push('- Higher scores and STRONG status indicate stronger positive signals.');
  lines.push('- Cite specific Lens names in your evidence bullets.');
  lines.push('- Be concise, actionable, and grounded in the Lens findings provided.');

  return lines.join('\n');
}

/**
 * Build the full L3 LLM prompt for AI Insight synthesis.
 *
 * @param {string}      insightType    "management" | "opportunity" | "deal"
 * @param {object[]}    lensScores     LensScore rows with lens_data populated
 * @param {string|null} promptTemplate DB-overridable template (falls back to DEFAULT)
 * @returns {string}
 */
function aiInsightSynthesisPrompt(insightType, lensScores, promptTemplate) {
  const template  = promptTemplate || DEFAULT_PROMPT_TEMPLATE;
  const dataBlock = buildDataBlock(insightType, lensScores);
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { aiInsightSynthesisPrompt, buildDataBlock, DEFAULT_PROMPT_TEMPLATE };
