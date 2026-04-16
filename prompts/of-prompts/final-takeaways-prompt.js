'use strict';


/**
 * Assemble the runtime data block from the 4 completed section results.
 */
function buildDataBlock(subjectTicker, industry, sections) {
  const fmt = (section, key) => section?.[key] ?? 'N/A';
  const score = (section) => section?.final_scoring?.score ?? 'N/A';
  const status = (section) => section?.final_scoring?.status ?? 'N/A';
  const takeaway = (section) => section?.text?.takeaway ?? 'N/A';

  const { industry_overview: ind, competition: comp, financial_strength: fin, customer_traction: cust } = sections;

  return `SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}

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
   Active customers    : ${cust?.metrics?.active_customers ?? 'N/A'}`;
}

/**
 * Build the final takeaways prompt.
 *
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {object} sections - { industry_overview, competition, financial_strength, customer_traction }
 * @param {string|null} [dbTemplate=null]
 */
function finalTakeawaysPrompt(subjectTicker, industry, sections, dbTemplate) {
  if (!dbTemplate) throw new Error('[finalTakeawaysPrompt] dbTemplate is required — configure skill "ofactor-final-takeaways" in DB');

  const dataBlock = buildDataBlock(subjectTicker, industry, sections);

  return dbTemplate
    .replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { finalTakeawaysPrompt, buildDataBlock };
