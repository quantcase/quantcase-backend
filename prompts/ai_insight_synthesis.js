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
You are assessing whether to buy/hold/avoid this stock now. Synthesise across two dimensions:
1. Earnings Forecast: Extract EPS/revenue CAGR (bear/base/bull scenarios if available), key swing factor.
2. Earnings Quality: Extract quality verdict (high/mixed/low), cash conversion, accrual risks, red flags, AND re-rating direction (expanding/neutral/contracting) with rationale.

Scoring guide for verdict:
- STRONG (≥80): High quality + Strong CAGR (>18%) + Expanding re-rating
- MODERATE (60–79): High quality + Moderate CAGR (10–18%) or neutral re-rating
- CAUTIOUS (40–59): Mixed quality + Moderate CAGR; no clear catalyst
- WEAK (<40): Low quality + any red flag → override to Avoid regardless of CAGR

The headline must be a buy/hold/avoid call (e.g. "Accumulate — Earnings Inflection Visible", "Avoid Until Quality Improves"). The key_signals must cover: earnings growth rate, quality signal, and re-rating direction. Use quantified metrics from the lens data wherever available. If bear/base/bull EPS scenarios exist in the data, surface them in the thesis.`,

  management: `
SYNTHESIS FOCUS — MANAGEMENT (Trustworthiness & Competence Verdict):
You are assessing management quality and execution credibility. Synthesise across four dimensions:
1. Guidance Credibility: How consistently does management deliver on forward-looking promises? Guidance given vs. missed rate.
2. Disclosure & Honesty: Transparency and candour — proactive communication vs. defensive framing.
3. Capital Allocation: Discipline in deploying capital across growth, shareholder returns, and debt management.
4. Promoter Activity: Shareholding trends, insider buying/selling signals, alignment with minorities.

Scoring guide for verdict:
- STRONG (≥80): Consistent guidance delivery + Transparent disclosure + Disciplined capital allocation + Confident insiders
- MODERATE (60–79): Track record mostly sound; some guidance misses or defensive tone elements
- CAUTIOUS (40–59): Mixed track record — execution gaps or disclosure concerns
- WEAK (<40): History of missed guidance, defensive communication, or capital misallocation

The headline must be a management quality verdict (e.g. "Credible Executor", "Guidance Credibility Concern", "Execution Track Record Improving"). Each lens MUST include a subtitle of ≤5 words ALL CAPS summarising its verdict (e.g. "GUIDANCE MET CONSISTENTLY", "OPAQUE CAPEX PLAN", "INSIDER BUYING SIGNALS"). The 4 key_signals must each anchor to one dimension above, using quantified metrics wherever available.`,
};

const DEFAULT_PROMPT_TEMPLATE = `You are a senior financial analyst synthesising pre-computed Lens summaries into a frontend-ready investment insight card. Work ONLY from the Lens data provided — do not invent data.

{{TYPE_FRAMING}}
{{DATA_BLOCK}}

Return a single valid JSON object matching the required schema. Field-level constraints (word limits, formatting, counts) are in the schema descriptions — follow them exactly.

HIGHLIGHT RULE: Apply markdown highlights ONLY to fields longer than 5 words. Use **double asterisks** to bold key phrases in description, thesis, evidence, watch_outs, and lenses[].description. Use *single asterisks* to italicise 1–2 key terms in headline and subtitle. Never bold or italicise short fields (key_signals labels, signal_map signals/summary, lenses subtitle). Never bold a full sentence — highlight only the most diagnostic phrase per sentence/item.`;

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
