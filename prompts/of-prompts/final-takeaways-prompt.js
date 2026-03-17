'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

/**
 * Build the final_takeaways synthesis prompt from all 4 completed section results.
 *
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {object} sections  - { industry_overview, competition, financial_strength, customer_traction }
 */
function finalTakeawaysPrompt(subjectTicker, industry, sections) {
  const fmt = (section, key) => section?.[key] ?? 'N/A';
  const score = (section) => section?.final_scoring?.score ?? 'N/A';
  const status = (section) => section?.final_scoring?.status ?? 'N/A';
  const takeaway = (section) => section?.text?.takeaway ?? 'N/A';

  const { industry_overview: ind, competition: comp, financial_strength: fin, customer_traction: cust } = sections;

  const schemaString = JSON.stringify({ final_takeaways: OFactorResponseSchema.final_takeaways }, null, 2);

  return `You are a senior equity research analyst. Synthesize the four OFactor section analyses below into a concise investment summary for ${subjectTicker} (${industry}).

══════════════════════════════════════════════════════════
SECTION SCORES & TAKEAWAYS
══════════════════════════════════════════════════════════

1. INDUSTRY OVERVIEW  [Score: ${score(ind)}/10 | ${status(ind)}]
   Takeaway : ${takeaway(ind)}
   Demand signal    : ${fmt(ind?.metrics, 'demand_signal')}
   Supply constraint: ${fmt(ind?.metrics, 'supply_constraint')}
   OPM              : ${ind?.metrics?.current_opm?.value ?? 'N/A'}  (YoY: ${ind?.metrics?.current_opm?.change ?? 'N/A'})
   Industry ROCE    : ${ind?.metrics?.industry_roce?.value ?? 'N/A'}  (YoY: ${ind?.metrics?.industry_roce?.change ?? 'N/A'})
   OPM outlook      : ${ind?.text?.opm_trend?.forward_outlook ?? 'N/A'}

2. COMPETITION  [Score: ${score(comp)}/10 | ${status(comp)}]
   Takeaway : ${takeaway(comp)}
   Market position       : ${comp?.metrics?.market_position ?? 'N/A'}
   Pricing power         : ${comp?.metrics?.pricing_power ?? 'N/A'}
   Competitive intensity : ${comp?.metrics?.competitive_intensity ?? 'N/A'}
   Porter's score        : ${comp?.metrics?.porters_score ?? 'N/A'}

3. FINANCIAL STRENGTH  [Score: ${score(fin)}/10 | ${status(fin)}]
   Takeaway : ${takeaway(fin)}
   Revenue growth  : ${fin?.metrics?.revenue?.change ?? 'N/A'}
   EBITDA margin   : ${fin?.metrics?.ebitda_margin?.value ?? 'N/A'}
   ROCE            : ${fin?.metrics?.roce?.value ?? 'N/A'}
   ROE             : ${fin?.metrics?.roe?.value ?? 'N/A'}
   Free cash flow  : ${fin?.metrics?.free_cash_flow?.value ?? 'N/A'}
   FCF trajectory  : ${fin?.free_cash_flow?.growth_trajectory ?? 'N/A'}
   Balance sheet   : ${fin?.capital_structure?.debt_trajectory?.status ?? 'N/A'}

4. CUSTOMER TRACTION  [Score: ${score(cust)}/10 | ${status(cust)}]
   Takeaway : ${takeaway(cust)}
   Net retention       : ${cust?.metrics?.net_retention ?? 'N/A'}
   Top-10 concentration: ${cust?.metrics?.top_10_concentration ?? 'N/A'}
   Active customers    : ${cust?.metrics?.active_customers ?? 'N/A'}

══════════════════════════════════════════════════════════
INSTRUCTIONS
══════════════════════════════════════════════════════════

Using ONLY the information above:

1. overall_score  — sum of the four section scores (max 40).
2. overall_status — STRONG (≥28), MODERATE (18–27), WEAK (<18).
3. status_color   — green for STRONG, yellow for MODERATE, red for WEAK.
4. investment_thesis — 1–2 sentences that capture the core opportunity and main risk. 
5. key_highlights — 3–5 concise bullet points (10–15 words each), one per strongest positive.
6. key_risks      — 2–3 concise bullet points (10–15 words each), one per top concern.
7. section_scores — copy score, status, and takeaway from each section above (do NOT paraphrase the takeaway).
8. Keep the language in thesis, risks and highlights simple and easy to understand. You may mention hard metrics in parentheses.
9. Whenever you give an insight, try incorporating a short metric in parentheses to back it with hard data.
Output length: keep investment_thesis under 40 words; each highlight/risk under 15 words.

══════════════════════════════════════════════════════════
OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { finalTakeawaysPrompt };
