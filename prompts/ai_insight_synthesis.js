'use strict';

// Type-specific framing injected before the output schema.
// Guides the LLM on what to prioritise per insight type — does NOT change the output schema.
const TYPE_FRAMING = {
  opportunity: `
SYNTHESIS FOCUS — OPPORTUNITY (Business Quality Verdict):
You are assessing whether this is a high-quality business worth owning. Synthesise across four dimensions:
1. Industry Analysis: Extract industry growth rate (TAM/volume CAGR), demand-supply balance, margin pool trend.
2. Competition: Extract market share position, barriers to entry, peer outperformance.
3. Financial Strength: Extract revenue CAGR, margin trajectory, FCF generation, leverage (Net Debt/EBITDA).
4. Customer/Distribution: Extract revenue concentration, order visibility, distribution reach.

Scoring guide for verdict:
- STRONG (≥80): Strong industry + Dominant competitive + Strong financials + Resilient customers
- MODERATE (60–79): At least 2 of 4 dimensions clearly positive; no major override
- CAUTIOUS (40–59): Mixed signals — sector tailwind masking structural weakness, or execution risk
- WEAK (<40): Stressed financials + Vulnerable competition → override regardless of industry score

The headline must be a business quality verdict (e.g. "High-Quality Compounder", "Sector Tailwind Masking Weakness"). The 4 key_signals must each anchor to one dimension (one from industry, one from competition, one from financials, one from customers). Use quantified metrics from the lens data wherever available.`,

  deal: `
SYNTHESIS FOCUS — DEAL (Investment Verdict):
You are assessing whether to buy/hold/avoid this stock now. Synthesise across three dimensions:
1. Earnings Forecast: Extract EPS/revenue CAGR (bear/base/bull scenarios if available), key swing factor.
2. Earning Quality: Extract quality verdict (high/mixed/low), cash conversion, accrual risks, red flags.
3. P/E Re-rating Potential: Extract re-rating direction (expanding/neutral/contracting), target P/E vs current, rationale.
4. Target Price Matrix: Extract upside %, price target, horizon.

Scoring guide for verdict:
- STRONG (≥80): High quality + Strong CAGR (>18%) + Expanding re-rating
- MODERATE (60–79): High quality + Moderate CAGR (10–18%) or neutral re-rating
- CAUTIOUS (40–59): Mixed quality + Moderate CAGR; no clear catalyst
- WEAK (<40): Low quality + any red flag → override to Avoid regardless of CAGR

The headline must be a buy/hold/avoid call (e.g. "Accumulate — Earnings Inflection Visible", "Avoid Until Quality Improves"). The key_signals must cover: earnings growth rate, quality signal, re-rating direction, and upside %. Use quantified metrics from the lens data wherever available. If bear/base/bull EPS scenarios exist in the data, surface them in the thesis.`,
};

const DEFAULT_PROMPT_TEMPLATE = `You are a senior financial analyst synthesising pre-computed Lens summaries into a frontend-ready investment insight card. Work ONLY from the Lens data provided — do not invent data.

{{TYPE_FRAMING}}
{{DATA_BLOCK}}

Return a single valid JSON object with this exact structure (no markdown fences, no extra keys):

{
  "score": <integer 0–100, overall composite score>,
  "verdict": <"STRONG" | "MODERATE" | "WEAK" | "CAUTIOUS">,
  "verdict_band": <short label — exactly one of: "STRONG BUY" | "MODERATE BAND" | "CAUTIOUS HOLD" | "WEAK / AVOID">,

  "headline": <≤8 words — punchy thesis. Italicise 1–2 key terms with *single asterisks*. GOOD: "*Execution* headwinds on core growth" (5w). BAD: "Scaled growth with *structural* tailwinds and fortress balance sheet" (9w).>,
  "subtitle": <≤10 words — single action or timing qualifier. Italicise the single most important term with *single asterisks*. GOOD: "Watch *greenfields* ramp before adding" (5w). BAD: "Greenfields ramp delays are offset by fortress balance sheet strength" (11w).>,
  "description": <2 short sentences MAX — each ≤20 words. Bold 1–2 key phrases per sentence with **double asterisks**. GOOD: "MSWIL posts **25.5% YoY revenue growth** with **fortress balance sheet**, but organic growth slumps to 1%." BAD: plain text with no highlights.>,

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
      "description": <1 sentence only ≤20 words — the single most important finding for this lens. Bold the key number or finding with **double asterisks**.>
    }
  ],

  "signal_map": [
    {
      "category": <≤3 words ALL CAPS — e.g. "ASSET QUALITY", "MARGIN RISK", "CORE GROWTH">,
      "signal": <HARD LIMIT ≤7 words. COUNT them. GOOD: "Core ex-greenfields at +1% YoY" (6w). BAD: "Greenfields ramp delays acknowledged; capacity absorption tracking needed" (8w).>,
      "summary": <1–3 words — tile value distinct from category. GOOD: "Strong YoY", "Margin squeeze", "+1% organic". NOT a repeat of category.>,
      "sentiment": <"positive" | "negative" | "neutral">
    }
  ],

  "thesis": <EXACTLY 2-3 sentences, each ≤30 words. NOT a paragraph — separate distinct sentences. Bold 1 key phrase per sentence with **double asterisks**. GOOD: "**Strong headline growth** masks weak core at +1% ex-greenfields. **Execution risk** on capacity absorption is the key watchout. Deal math works if **ramp stabilises**." BAD: one 80-word run-on paragraph with no highlights.>,
  "evidence": [<3–4 strings — HARD LIMIT ≤10 words each. COUNT them. Bold the key metric or number with **double asterisks**. GOOD: "**Ex-greenfields EBITDA** grew 7.6% stable margin" (7w). BAD: plain text without highlights.>],
  "watch_outs": [<2–3 strings — HARD LIMIT ≤8 words each. COUNT them. Bold the core risk term with **double asterisks**. GOOD: "**Greenfields ramp** delay compresses margins" (5w). BAD: plain text without highlights.>]
}

Rules:
- score 0–100: weighted average of (lens.score / lens.max_score) × 100 across all lenses
- max_score values must sum to 100 across all lenses in the array
- lenses array: one entry per input lens, same order
- signal_map: EXACTLY 8 signals — no more, no fewer. Pick the 8 most diagnostic ones across all lenses.
- key_signals: exactly 2–4 pills — the single most critical positive and negative data points
- WORD COUNT IS MANDATORY: count every word in key_signals, signal_map signals, evidence, watch_outs, headline, subtitle before writing. Truncate ruthlessly.
- Keep ALL text fields SHORT. This is a scorecard chip UI — every field renders in a small pill or label. Verbose answers break the UI.
- verdict_band: score ≥80 → STRONG BUY; 60–79 → MODERATE BAND; 40–59 → CAUTIOUS HOLD; <40 → WEAK / AVOID
- HIGHLIGHT RULE: Apply markdown highlights ONLY to fields longer than 5 words. Use **double asterisks** to bold key phrases in description, thesis, evidence, watch_outs, and lenses[].description. Use *single asterisks* to italicise 1–2 key terms in headline and subtitle. Never bold or italicise short fields (key_signals labels, signal_map signals/summary, lenses subtitle). Never bold a full sentence — highlight only the most diagnostic phrase per sentence/item.`;

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

    // Include quantified key_metrics so the LLM can anchor verdicts to real numbers
    const km = ld.key_metrics;
    if (km && typeof km === 'object') {
      const entries = Object.entries(km).slice(0, 6); // cap at 6 per lens for token budget
      if (entries.length > 0) {
        lines.push('  Key metrics:');
        entries.forEach(([k, v]) => lines.push(`    ${k}: ${v}`));
      }
    }

    // Include top signals (actual_value + statement) for quantified evidence
    if (Array.isArray(ld.top_signals) && ld.top_signals.length > 0) {
      const highImpact = ld.top_signals
        .filter(s => s.impact === 'high' && s.statement)
        .slice(0, 3);
      if (highImpact.length > 0) {
        lines.push('  Top signals:');
        highImpact.forEach(s => {
          const val = s.actual_value != null ? ` [${s.actual_value}${s.unit ? ' ' + s.unit : ''}]` : '';
          lines.push(`    - ${s.statement}${val}`);
        });
      }
    }

    lines.push('');
  }

  lines.push('Instructions:');
  lines.push('- Synthesise the above Lens summaries into a holistic investment insight.');
  lines.push('- Higher scores and STRONG status indicate stronger positive signals.');
  lines.push('- Cite specific Lens names in your evidence bullets.');
  lines.push('- Use the key_metrics and top_signals to anchor quantified values in headline, key_signals, signal_map, thesis, and evidence fields.');
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
  const template   = promptTemplate || DEFAULT_PROMPT_TEMPLATE;
  const dataBlock  = buildDataBlock(insightType, lensScores);
  const typeFraming = TYPE_FRAMING[insightType] ?? '';
  return template
    .replace('{{TYPE_FRAMING}}', typeFraming)
    .replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { aiInsightSynthesisPrompt, buildDataBlock, DEFAULT_PROMPT_TEMPLATE };
