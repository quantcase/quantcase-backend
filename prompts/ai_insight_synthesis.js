'use strict';

const DEFAULT_PROMPT_TEMPLATE = `You are a senior financial analyst synthesising pre-computed Lens summaries into a frontend-ready investment insight card. Work ONLY from the Lens data provided — do not invent data.

{{DATA_BLOCK}}

Return a single valid JSON object with this exact structure (no markdown fences, no extra keys):

{
  "score": <integer 0–100, overall composite score>,
  "verdict": <"STRONG" | "MODERATE" | "WEAK" | "CAUTIOUS">,
  "verdict_band": <short label — exactly one of: "STRONG BUY" | "MODERATE BAND" | "CAUTIOUS HOLD" | "WEAK / AVOID">,

  "headline": <≤8 words — punchy thesis. COUNT the words. GOOD: "*Execution* headwinds on core growth" (5w). BAD: "Scaled growth with *structural* tailwinds and fortress balance sheet" (9w).>,
  "subtitle": <≤10 words — single action or timing qualifier. GOOD: "Watch greenfields ramp before adding" (5w). BAD: "Greenfields ramp delays are offset by fortress balance sheet strength" (11w).>,
  "description": <2 short sentences MAX — each ≤20 words. Support the verdict, no padding.>,

  "key_signals": [
    {
      "label": <HARD LIMIT ≤5 words. COUNT them. GOOD: "Core growth only +1%" (4w), "25% headline revenue growth" (4w). BAD: "Core ex-greenfields growth collapsed to just +1% YoY" (9w).>,
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
      "subtitle": <≤5 words ALL CAPS — punchy thematic label, e.g. "BEATS ON CREDIT", "EXECUTION RISK", "FORTRESS BALANCE SHEET">,
      "description": <1 sentence only ≤20 words — the single most important finding for this lens>
    }
  ],

  "signal_map": [
    {
      "category": <≤3 words ALL CAPS — e.g. "ASSET QUALITY", "MARGIN RISK", "CORE GROWTH">,
      "signal": <HARD LIMIT ≤7 words. COUNT them. GOOD: "Core ex-greenfields at +1% YoY" (6w). BAD: "Greenfields ramp delays acknowledged; capacity absorption tracking needed" (8w).>,
      "sentiment": <"positive" | "negative" | "neutral">
    }
  ],

  "thesis": <EXACTLY 2-3 sentences, each ≤30 words. NOT a paragraph — separate distinct sentences. GOOD: "Strong headline growth masks weak core at +1% ex-greenfields. Execution risk on capacity absorption is the key watchout. Deal math works if ramp stabilises." BAD: one 80-word run-on paragraph.>,
  "evidence": [<3–4 strings — HARD LIMIT ≤10 words each. COUNT them. GOOD: "Ex-greenfields EBITDA grew 7.6% stable margin" (7w). BAD: "Management proactively acknowledged slower-than-expected greenfields capacity ramp-up issues" (8w — borderline ok, but trim where possible).>],
  "watch_outs": [<2–3 strings — HARD LIMIT ≤8 words each. COUNT them. GOOD: "Greenfields ramp delay compresses margins" (5w). BAD: "25% project-revenue exposure creates earnings volatility and sustainability risk" (9w).>]
}

Rules:
- score 0–100: weighted average of (lens.score / lens.max_score) × 100 across all lenses
- max_score values must sum to 100 across all lenses in the array
- lenses array: one entry per input lens, same order
- signal_map: exactly 6–8 signals — pick only the most diagnostic ones, skip generic statements
- key_signals: exactly 2–4 pills — the single most critical positive and negative data points
- WORD COUNT IS MANDATORY: count every word in key_signals, signal_map signals, evidence, watch_outs, headline, subtitle before writing. Truncate ruthlessly.
- Keep ALL text fields SHORT. This is a scorecard chip UI — every field renders in a small pill or label. Verbose answers break the UI.
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
