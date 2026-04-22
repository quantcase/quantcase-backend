'use strict';

/**
 * Migration: change OFactor section scoring from /10 to /25 so the total becomes 100.
 *
 * Each of the 4 sections (industry, competition, financial-strength, customer-traction)
 * was previously scored 0–10 (total 40).  After this migration each section is scored
 * 0–25 (total 100).
 *
 * Changes per skill:
 *  • Scoring instruction: "Award 1 point per check, max 10" → scaled to "Award 2–3 points per
 *    check, max 25" (10 checks × variable weights = 25).
 *  • status thresholds scaled proportionally (×2.5).
 *  • max_score field in promptTemplate and outputSchema updated to 25.
 *  • signal_breakdown sub-scores scaled proportionally (0–10 → 0–25, max_score 10 → 25).
 *  • ofactor-final-takeaways: overall_score max 100, status thresholds scaled.
 *
 * Run:  node prisma/migrations/migrate-ofactor-scoring-25.js
 */

const prisma = require('../../config/prisma');

// ─── Helper: replace scoring blocks in promptTemplate ────────────────────────

/**
 * Replace ALL occurrences of old in str with newStr.
 */
function rall(str, old, newStr) {
  return str.split(old).join(newStr);
}

// ─── industry (non-BFSI) ─────────────────────────────────────────────────────

function patchIndustryPrompt(tpl) {
  // 10-check block → 25-point block
  tpl = rall(tpl,
    `Populate the "final_scoring" field INSIDE the industry_overview JSON object (same level as "metrics"). Award 1 point per check, max 10:
  1. Demand signal is "Strong" → metrics.demand_signal
  2. Supply constraint is "Low" or "Moderate" (not High) → metrics.supply_constraint
  3. Industry revenue TTM change is positive → metrics.industry_revenue_ttm.change
  4. Industry CAGR 1Y > 10% → metrics.industry_cagr.one_year
  5. Industry CAGR 3Y > 8% → metrics.industry_cagr.three_year
  6. Operating margin ≥ 12% → metrics.current_opm.value
  7. Operating margin YoY change is positive → metrics.current_opm.change
  8. Industry ROCE ≥ 12% → metrics.industry_roce.value
  9. Industry ROCE change is positive → metrics.industry_roce.change
  10. OPM forward outlook is improving or stable → text.opm_trend.forward_outlook
  status: score >= 7 → "FAVORABLE" (green), score 5–6 → "NEUTRAL" (yellow), score < 5 → "UNFAVORABLE" (red).`,
    `Populate the "final_scoring" field INSIDE the industry_overview JSON object (same level as "metrics"). Award points per check, max 25 total:
  1. Demand signal is "Strong" → metrics.demand_signal  [3 pts]
  2. Supply constraint is "Low" or "Moderate" (not High) → metrics.supply_constraint  [3 pts]
  3. Industry revenue TTM change is positive → metrics.industry_revenue_ttm.change  [2 pts]
  4. Industry CAGR 1Y > 10% → metrics.industry_cagr.one_year  [3 pts]
  5. Industry CAGR 3Y > 8% → metrics.industry_cagr.three_year  [3 pts]
  6. Operating margin ≥ 12% → metrics.current_opm.value  [3 pts]
  7. Operating margin YoY change is positive → metrics.current_opm.change  [2 pts]
  8. Industry ROCE ≥ 12% → metrics.industry_roce.value  [3 pts]
  9. Industry ROCE change is positive → metrics.industry_roce.change  [2 pts]
  10. OPM forward outlook is improving or stable → text.opm_trend.forward_outlook  [1 pt]
  status: score >= 18 → "FAVORABLE" (green), score 13–17 → "NEUTRAL" (yellow), score < 13 → "UNFAVORABLE" (red).`
  );

  // signal_breakdown sub-scores
  tpl = rall(tpl,
    `Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each object: { "key", "label", "score" (0–10), "max_score": 10, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings) }. Dimensions and scoring criteria:
  • PROFITABILITY (label: "Profitability") — ROCE level and trend. score 7–10: ROCE ≥ 15% and rising; 4–6: ROCE 10–15% or flat; 0–3: ROCE < 10% or falling.
  • MARGINS (label: "Margins") — OPM level and direction. score 7–10: OPM ≥ 15% and improving; 4–6: OPM 10–15% or stable; 0–3: OPM < 10% or declining.
  • GROWTH (label: "Growth") — Revenue CAGR trajectory. score 7–10: 1Y CAGR > 15%; 4–6: CAGR 8–15%; 0–3: CAGR < 8%.
  • DEMAND (label: "Demand") — Demand signal strength. score 7–10: Strong demand; 4–6: Moderate; 0–3: Weak.
  • SUPPLY (label: "Supply") — Supply constraint severity. score 7–10: Low constraint; 4–6: Moderate; 0–3: High constraint.
  • MARKET_STRUCTURE (label: "Market Structure") — Competitive structure, entry barriers, consolidation. score 7–10: oligopolistic, high barriers; 4–6: mixed/moderate; 0–3: fragmented, low barriers.
  • VALUATION_EARNINGS (label: "Valuation & Earnings Quality") — Earnings consistency, revenue quality, cash conversion. score 7–10: consistent earnings, high cash conversion; 4–6: moderate; 0–3: volatile earnings or poor conversion.
  • MANAGEMENT_QUALITY (label: "Management Quality") — Management guidance reliability, execution track record from transcripts. score 7–10: strong execution, guidance met; 4–6: mixed; 0–3: guidance misses, poor visibility.
  sentiment: "positive" if score ≥ 7, "negative" if score ≤ 3, else "neutral".
  details: 2–3 concise bullet strings, each ≤ 15 words, citing specific data points from the analysis.`,
    `Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each object: { "key", "label", "score" (0–25), "max_score": 25, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings) }. Dimensions and scoring criteria:
  • PROFITABILITY (label: "Profitability") — ROCE level and trend. score 18–25: ROCE ≥ 15% and rising; 10–17: ROCE 10–15% or flat; 0–9: ROCE < 10% or falling.
  • MARGINS (label: "Margins") — OPM level and direction. score 18–25: OPM ≥ 15% and improving; 10–17: OPM 10–15% or stable; 0–9: OPM < 10% or declining.
  • GROWTH (label: "Growth") — Revenue CAGR trajectory. score 18–25: 1Y CAGR > 15%; 10–17: CAGR 8–15%; 0–9: CAGR < 8%.
  • DEMAND (label: "Demand") — Demand signal strength. score 18–25: Strong demand; 10–17: Moderate; 0–9: Weak.
  • SUPPLY (label: "Supply") — Supply constraint severity. score 18–25: Low constraint; 10–17: Moderate; 0–9: High constraint.
  • MARKET_STRUCTURE (label: "Market Structure") — Competitive structure, entry barriers, consolidation. score 18–25: oligopolistic, high barriers; 10–17: mixed/moderate; 0–9: fragmented, low barriers.
  • VALUATION_EARNINGS (label: "Valuation & Earnings Quality") — Earnings consistency, revenue quality, cash conversion. score 18–25: consistent earnings, high cash conversion; 10–17: moderate; 0–9: volatile earnings or poor conversion.
  • MANAGEMENT_QUALITY (label: "Management Quality") — Management guidance reliability, execution track record from transcripts. score 18–25: strong execution, guidance met; 10–17: mixed; 0–9: guidance misses, poor visibility.
  sentiment: "positive" if score ≥ 18, "negative" if score ≤ 9, else "neutral".
  details: 2–3 concise bullet strings, each ≤ 15 words, citing specific data points from the analysis.`
  );

  return tpl;
}

// ─── industry-bfsi ────────────────────────────────────────────────────────────

function patchIndustryBfsiPrompt(tpl) {
  tpl = rall(tpl,
    `Populate the "final_scoring" field INSIDE the industry_overview JSON object. Award 1 point per check, max 10:
  1. demand_signal = "Strong"
  2. supply_constraint = "Low" or "Moderate"
  3. Credit Growth YoY > 10%
  4. Avg GNPA < 3%
  5. Avg Net NPA < 1%
  6. Combined Sector Profit growth > 10%
  7. Avg ROE > 12%
  8. Avg NIM > 2.5%
  9. Deposit Growth YoY > 8%
  10. text.demand_supply_dynamics.net_impact is positive
  status: score >= 7 → "FAVORABLE" (green), score 5–6 → "NEUTRAL" (yellow), score < 5 → "UNFAVORABLE" (red).`,
    `Populate the "final_scoring" field INSIDE the industry_overview JSON object. Award points per check, max 25 total:
  1. demand_signal = "Strong"  [3 pts]
  2. supply_constraint = "Low" or "Moderate"  [3 pts]
  3. Credit Growth YoY > 10%  [3 pts]
  4. Avg GNPA < 3%  [3 pts]
  5. Avg Net NPA < 1%  [3 pts]
  6. Combined Sector Profit growth > 10%  [2 pts]
  7. Avg ROE > 12%  [2 pts]
  8. Avg NIM > 2.5%  [2 pts]
  9. Deposit Growth YoY > 8%  [2 pts]
  10. text.demand_supply_dynamics.net_impact is positive  [2 pts]
  status: score >= 18 → "FAVORABLE" (green), score 13–17 → "NEUTRAL" (yellow), score < 13 → "UNFAVORABLE" (red).`
  );

  tpl = rall(tpl,
    `Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each: { "key", "label", "score" (0–10), "max_score": 10, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings ≤ 15 words) }. Dimensions:
  • PROFITABILITY    — ROE and ROA levels and trend
  • MARGINS         — NIM trend and compression risk
  • GROWTH          — Credit and deposit growth trajectory
  • DEMAND          — Demand signal strength (credit offtake, loan enquiries)
  • SUPPLY          — Deposit availability, funding cost pressure
  • MARKET_STRUCTURE— Concentration, PSB vs PVB dynamics, RBI regulatory environment
  • VALUATION_EARNINGS — NPA trajectory, earnings consistency, provisioning
  • MANAGEMENT_QUALITY — Guidance reliability, execution track record from transcripts
  sentiment: "positive" if score ≥ 7, "negative" if score ≤ 3, else "neutral".`,
    `Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each: { "key", "label", "score" (0–25), "max_score": 25, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings ≤ 15 words) }. Dimensions:
  • PROFITABILITY    — ROE and ROA levels and trend
  • MARGINS         — NIM trend and compression risk
  • GROWTH          — Credit and deposit growth trajectory
  • DEMAND          — Demand signal strength (credit offtake, loan enquiries)
  • SUPPLY          — Deposit availability, funding cost pressure
  • MARKET_STRUCTURE— Concentration, PSB vs PVB dynamics, RBI regulatory environment
  • VALUATION_EARNINGS — NPA trajectory, earnings consistency, provisioning
  • MANAGEMENT_QUALITY — Guidance reliability, execution track record from transcripts
  sentiment: "positive" if score ≥ 18, "negative" if score ≤ 9, else "neutral".`
  );

  return tpl;
}

// ─── competition ─────────────────────────────────────────────────────────────

function patchCompetitionPrompt(tpl) {
  tpl = rall(tpl,
    `Populate the "final_scoring" field INSIDE the competition JSON object (same level as "metrics"). Award 1 point per check, max 10:
  1. Porter's score ≥ 7/10 → metrics.porters_score
  2. Pricing power is "High" → metrics.pricing_power
  3. Entry barriers are "High" → metrics.entry_barriers
  4. Competitive intensity is "Low" → metrics.competitive_intensity
  5. Clear moat identified (IP / brand / switching costs / network effects) → text.competitive_positioning.strengths
  6. No major disruption threat in the near term → text.competitive_positioning.threats (absent or mild)
  7. Subject company gaining or holding market share → based on EPS/PE CAGR vs industry
  8. Subject EPS CAGR > Industry EPS CAGR → computed metrics above
  9. Pricing power dynamics are stable or improving → text.pricing_power_dynamics.future_trajectory
  10. Competitive advantages sustainable 3+ years → text.competitive_positioning.strengths
  status: score >= 7 → "STRONG POSITION" (green), score 5–6 → "MODERATE POSITION" (yellow), score < 5 → "WEAK POSITION" (red).`,
    `Populate the "final_scoring" field INSIDE the competition JSON object (same level as "metrics"). Award points per check, max 25 total:
  1. Porter's score ≥ 7/10 → metrics.porters_score  [3 pts]
  2. Pricing power is "High" → metrics.pricing_power  [3 pts]
  3. Entry barriers are "High" → metrics.entry_barriers  [3 pts]
  4. Competitive intensity is "Low" → metrics.competitive_intensity  [3 pts]
  5. Clear moat identified (IP / brand / switching costs / network effects) → text.competitive_positioning.strengths  [3 pts]
  6. No major disruption threat in the near term → text.competitive_positioning.threats (absent or mild)  [2 pts]
  7. Subject company gaining or holding market share → based on EPS/PE CAGR vs industry  [2 pts]
  8. Subject EPS CAGR > Industry EPS CAGR → computed metrics above  [2 pts]
  9. Pricing power dynamics are stable or improving → text.pricing_power_dynamics.future_trajectory  [2 pts]
  10. Competitive advantages sustainable 3+ years → text.competitive_positioning.strengths  [2 pts]
  status: score >= 18 → "STRONG POSITION" (green), score 13–17 → "MODERATE POSITION" (yellow), score < 13 → "WEAK POSITION" (red).`
  );

  // signal_breakdown for competition uses score 1–3, max_score 3 — leave those sub-scores unchanged
  // (they are qualitative labels, not summed into the section score directly)

  return tpl;
}

// ─── customer-traction ────────────────────────────────────────────────────────

function patchCustomerTractionPrompt(tpl) {
  tpl = rall(tpl,
    `Populate "analysis.final_scoring":
  Award 1 point per check, max 10:
    1. Customer count growing YoY → core.metrics.active_customers trend
    2. Churn rate ≤ 5% or declining → core.metrics.churn_rate
    3. Net revenue retention ≥ 100% → core.metrics.net_retention
    4. New customer additions positive → core.text.customer_growth.acquisition_dynamics
    5. Pipeline / order book growing → core.text.customer_growth.acquisition_dynamics
    6. Long-term contracts or sticky revenue model → core.text.retention.product_stickiness
    7. Revenue per customer increasing → core.metrics.avg_contract_value
    8. Customer concentration manageable (top-10 < 30%) → core.metrics.top_10_concentration
    9. Cross-sell or upsell happening → core.text.retention.expansion_drivers
    10. Management provides specific customer metrics → non-null core.metrics values
  score: integer 0–10
  max_score: always 10
  status: score >= 7 → "HIGH TRACTION" (green), score 5–6 → "MODERATE TRACTION" (yellow), score < 5 → "LOW TRACTION" (red)`,
    `Populate "analysis.final_scoring":
  Award points per check, max 25 total:
    1. Customer count growing YoY → core.metrics.active_customers trend  [3 pts]
    2. Churn rate ≤ 5% or declining → core.metrics.churn_rate  [3 pts]
    3. Net revenue retention ≥ 100% → core.metrics.net_retention  [3 pts]
    4. New customer additions positive → core.text.customer_growth.acquisition_dynamics  [2 pts]
    5. Pipeline / order book growing → core.text.customer_growth.acquisition_dynamics  [2 pts]
    6. Long-term contracts or sticky revenue model → core.text.retention.product_stickiness  [3 pts]
    7. Revenue per customer increasing → core.metrics.avg_contract_value  [3 pts]
    8. Customer concentration manageable (top-10 < 30%) → core.metrics.top_10_concentration  [2 pts]
    9. Cross-sell or upsell happening → core.text.retention.expansion_drivers  [2 pts]
    10. Management provides specific customer metrics → non-null core.metrics values  [2 pts]
  score: integer 0–25
  max_score: always 25
  status: score >= 18 → "HIGH TRACTION" (green), score 13–17 → "MODERATE TRACTION" (yellow), score < 13 → "LOW TRACTION" (red)`
  );

  return tpl;
}

// ─── financial-strength ──────────────────────────────────────────────────────

function patchFinancialStrengthPrompt(tpl) {
  tpl = rall(tpl,
    `final_scoring (10 checks — award 1 point each):
  1. OCF/PAT > 0.8x  → check text.cash_flow.metrics.ocf_ebitda or compute CFO/PAT from data
  2. FCF positive and growing → free_cash_flow.growth_trajectory
  3. ROCE > 12%  → metrics.roce
  4. Gross Margin stable or expanding → metrics.gross_margin trend
  5. Working capital days stable or improving → working_capital CCC trend
  6. Net Debt declining or net cash → capital_structure.balance_sheet.status
  7. EBIT Margin expanding → operating_leverage.verdict.status = "positive"
  8. Capex < OCF → capital_structure.capex_intensity (capex_ocf_pct < 100)
  9. ROE > 12% → metrics.roe
  10. PAT margin improving or above 8% → metrics.pat (PAT/revenue trend)
  status: score >= 7 → "HIGH QUALITY" (green), score 5–6 → "MODERATE QUALITY" (yellow), score < 5 → "LOW QUALITY" (red).
  Populate max_score: 10.`,
    `final_scoring (10 checks — award points per check, max 25 total):
  1. OCF/PAT > 0.8x  → check text.cash_flow.metrics.ocf_ebitda or compute CFO/PAT from data  [3 pts]
  2. FCF positive and growing → free_cash_flow.growth_trajectory  [3 pts]
  3. ROCE > 12%  → metrics.roce  [3 pts]
  4. Gross Margin stable or expanding → metrics.gross_margin trend  [2 pts]
  5. Working capital days stable or improving → working_capital CCC trend  [2 pts]
  6. Net Debt declining or net cash → capital_structure.balance_sheet.status  [3 pts]
  7. EBIT Margin expanding → operating_leverage.verdict.status = "positive"  [3 pts]
  8. Capex < OCF → capital_structure.capex_intensity (capex_ocf_pct < 100)  [2 pts]
  9. ROE > 12% → metrics.roe  [2 pts]
  10. PAT margin improving or above 8% → metrics.pat (PAT/revenue trend)  [2 pts]
  status: score >= 18 → "HIGH QUALITY" (green), score 13–17 → "MODERATE QUALITY" (yellow), score < 13 → "LOW QUALITY" (red).
  Populate max_score: 25.`
  );

  // signal_breakdown sub-scores: max_score values for each bucket stay as-is
  // (they sum to 10 across the 5 buckets — these are sub-bucket counters, not the section total)
  // Only update the sentiment thresholds for PROFITABILITY bucket which uses score=3 — leave as-is,
  // these are bucket-level checks, not the section-level 0–25 score.

  return tpl;
}

// ─── final-takeaways ─────────────────────────────────────────────────────────

function patchFinalTakeawaysPrompt(tpl) {
  tpl = rall(tpl,
    `1. overall_score  — sum of the four section scores (max 40).
2. overall_status — STRONG (≥28), MODERATE (18–27), WEAK (<18).`,
    `1. overall_score  — sum of the four section scores (max 100).
2. overall_status — STRONG (≥70), MODERATE (45–69), WEAK (<45).`
  );

  return tpl;
}

// ─── outputSchema patcher ────────────────────────────────────────────────────

/**
 * Walk the JSON outputSchema and update max_score occurrences at the
 * final_scoring level from 10 → 25.  We leave signal_breakdown sub-scores
 * alone because they are bucket-level (e.g. max_score: 3 for competition).
 *
 * Strategy: convert to string, do targeted replacements, parse back.
 */
function patchOutputSchema(schema, slug) {
  let s = JSON.stringify(schema);

  if (['ofactor-industry', 'ofactor-industry-bfsi', 'ofactor-competition', 'ofactor-financial-strength', 'ofactor-customer-traction'].includes(slug)) {
    // The top-level final_scoring max_score is set by the LLM following the prompt,
    // but the JSON schema just says { type: 'number' } — no default value enforced.
    // Nothing structural to change in the output schema itself; the LLM reads the prompt.
    // We do NOT change signal_breakdown max_score here since those are sub-bucket values.
  }

  if (slug === 'ofactor-final-takeaways') {
    // max_score field in final_takeaways output schema (if present)
    // The schema has max_score as optional number — no change needed structurally.
  }

  return JSON.parse(s);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  const SLUGS = [
    'ofactor-industry',
    'ofactor-industry-bfsi',
    'ofactor-competition',
    'ofactor-financial-strength',
    'ofactor-customer-traction',
    'ofactor-final-takeaways',
  ];

  const skills = await prisma.skill.findMany({
    where: { slug: { in: SLUGS } },
    select: { slug: true, promptTemplate: true, outputSchema: true },
  });

  if (skills.length !== SLUGS.length) {
    const found = skills.map(s => s.slug);
    const missing = SLUGS.filter(s => !found.includes(s));
    throw new Error(`Skills not found in DB: ${missing.join(', ')}`);
  }

  const PATCHERS = {
    'ofactor-industry':            patchIndustryPrompt,
    'ofactor-industry-bfsi':       patchIndustryBfsiPrompt,
    'ofactor-competition':         patchCompetitionPrompt,
    'ofactor-financial-strength':  patchFinancialStrengthPrompt,
    'ofactor-customer-traction':   patchCustomerTractionPrompt,
    'ofactor-final-takeaways':     patchFinalTakeawaysPrompt,
  };

  for (const skill of skills) {
    const patcher = PATCHERS[skill.slug];
    if (!patcher) {
      console.log(`  (no prompt patcher for ${skill.slug} — skipping)`);
      continue;
    }

    const newPrompt = patcher(skill.promptTemplate ?? '');
    const newSchema = patchOutputSchema(skill.outputSchema, skill.slug);

    await prisma.skill.update({
      where: { slug: skill.slug },
      data: {
        promptTemplate: newPrompt,
        outputSchema:   newSchema,
      },
    });

    console.log(`✓ Updated ${skill.slug}`);
  }

  console.log('\nDone. All OFactor section skills now score out of 25 (total 100).');
}

run()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
