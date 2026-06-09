'use strict';

/**
 * V2 transcript extraction prompt.
 *
 * {{DATA_BLOCK}} is replaced at runtime by buildDataBlockV2() — it contains:
 *   - CALL DATE / FISCAL YEAR END
 *   - AVAILABLE KPIs list (for dedup — same flow as v1)
 *   - TRANSCRIPT text
 *
 * KPI reference list is injected for 6 signal types that carry a named metric:
 *   guidance, growth_forecast, kpi, earnings_quality, guidance_revision, claim.
 * The other 8 types use controlled enums or free-text labels — no KPI list needed.
 */

const PROMPT_TEMPLATE_V2 = `QUANTCASE — TRANSCRIPT SIGNAL EXTRACTION PROMPT

PURPOSE
Extract structured investment signals from earnings call transcripts.
Source type for all signals: "earnings call".

Identify three structural sections before extracting:
  1. opening_remarks
  2. management_presentation
  3. analyst_qa

Tag every signal with its section (source_context).

SECTION BOUNDARY RULES
- opening_remarks: first word spoken by any company representative.
- analyst_qa: begins when the first analyst name appears. If management volunteers new information while answering, tag as analyst_qa — session overrides content.
- management_presentation: everything between opening_remarks and analyst_qa.
- If boundary is unclear, default to management_presentation.

{{DATA_BLOCK}}

----------------------

## DATE FORMATTING RULES
- All dates must be in YYYY-MM-DD format.
- If a date is vague, resolve it to the LAST DAY of the implied period:
  - "next fiscal year" → last day of next fiscal year based on FISCAL YEAR END
  - "by Q3" → last day of Q3 relative to fiscal year end
  - "H1" → last day of the first half of the fiscal year
  - "near term" / "shortly" → 6 months from CALL DATE
  - "medium term" → 18 months from CALL DATE
  - "long term" → 36 months from CALL DATE
- If truly unresolvable, use null.

----------------------

## KPI ABBREVIATION RULES
These rules apply to every field marked "(KPI abbr)" in the signal type definitions below.

1. Always check AVAILABLE KPIs first. Use the exact abbr from that list.
2. If the metric is not in the list → add it to new_kpis and use the abbr you assign there.
3. KPI abbrs are TIMELESS — never embed a period, quarter, or fiscal year in the abbr.
   Use REV not REV_Q3; use EBITDA not EBITDA_9M; use PAT not PAT_FY25.
   Time belongs in period_start / period_end / guidance_period_start / guidance_period_end.
4. Segment KPIs: prefix with SEG_<SEGMENT>_<ABBR> (e.g. SEG_RETAIL_REV).
   Always register in new_kpis if not in AVAILABLE KPIs.
5. Company-prefixed (JAI_EBITDA) and unprefixed (EBITDA) represent the same metric.
   Check both forms before registering a new one.

----------------------

## SIGNAL TYPES

Every signal must have: signal_id (unique within this run), source_statement_id,
source_context, impact, and severity.
One statement can emit multiple signals — link them with the same source_statement_id.
No statement should be extracted twice as the same signal type.


### SIGNAL TYPE 1: guidance
Use for: Any forward-looking statement management makes about the future.

guidance_category
  quantitative       — specific number, range, or ratio (e.g. "15–16% margins", "₹5,000 Cr revenue")
  qualitative_directional — directional but no number (e.g. "margins will improve")
  timeline_milestone — event expected by a specific date or period

Fields:
  metric              (KPI abbr) — use AVAILABLE KPIs; register new in new_kpis
  guided_value        decimal | null — null if qualitative; no units, no commas
  guided_value_raw    string — verbatim figure exactly as spoken (e.g. "double-digit", "15–16%")
  guided_unit         "Cr" | "%" | "x" | "₹" | null
  baseline_value_raw  string | null — current/base value stated; null if not mentioned
  guidance_period_start ISO date | null
  guidance_period_end   ISO date | null
  is_conditional      boolean — true if guidance depends on an external condition
  condition           string | null — stated condition; null if not conditional
  statement           string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 2: industry_signal
Use for: Market-level insights — not company-specific. Demand trends, supply dynamics,
competitive moves, M&A activity, regulatory changes. Extract even when mentioned in passing.

industry_category
  demand       — end-market demand drivers, growth rates, structural tailwinds/headwinds
  supply       — capacity additions, input cost trends, supply constraints
  competition  — market share shifts, new entrants, pricing pressure, peer performance
  ma_activity  — acquisitions, divestments, consolidation in the sector
  regulatory   — policy changes, compliance requirements, incentives, restrictions
  global       — export/import dynamics, other countries impacting the industry
  macro        — GDP, credit growth, interest rates, currency — only when linked to business

Fields:
  topic           string — short descriptive label (e.g. "housing_demand_recovery", "steel_capacity_glut")
  industry_category string — from list above
  direction       "positive" | "negative" | "neutral" | "uncertain"
  horizon         "near_term" (0–12m) | "medium_term" (1–3y) | "long_term" (3y+)
  drivers         string[] — up to 5 driver phrases (max 8 words each)
  value           decimal | null
  value_raw       string | null — verbatim figure or short description
  value_unit      "%" | "x" | "Cr" | null
  statement       string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 3: capital_allocation
Use for: How management is deploying capital — where it goes, return expectations, timeline.

allocation_category
  capex               — expansion, maintenance, new facilities, technology
  ma                  — acquisitions, divestments, JVs, stake purchases/sales
  debt_management     — fresh borrowings, repayments, refinancing, leverage targets
  shareholder_returns — dividends, buybacks, payout ratio guidance
  r_and_d             — product, brand, or technology investment

Fields:
  allocation_category string — from list above
  description         string — what is being allocated (max 20 words)
  quantum_value       decimal | null
  quantum_value_raw   string | null — verbatim figure (e.g. "₹2,000 Cr over 3 years")
  quantum_unit        "Cr" | "%" | "x" | null
  return_expectation  string | null — stated return metric; null if not stated
  timeline            string | null — when deployed; null if not stated
  statement           string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 4: disclosure_quality
Use for: How management handles bad news.
Central question: is management proactively transparent, or do they only admit problems when pressed?

disclosure_category
  proactive_bad_news     — management volunteers a negative without being asked
  reactive_bad_news      — management acknowledges an issue only when directly questioned
  proactive_good_news    — management highlights a genuine positive
  selective_omission     — material negative visible in KPIs but not addressed by management
  auditor_or_regulatory_flag — SEBI/regulatory action, auditor comments, or legal acts

Fields:
  disclosure_category  string — from list above
  topic                string — what is being disclosed (e.g. "NIM compression", "order book slippage")
  trigger              "unsolicited" | "analyst_question" | "inferred_from_data"
  management_framing   string — one sentence: how management described or framed this
  severity_of_issue    "critical" | "high" | "medium" | "low" — the underlying business issue
  statement            string | null — verbatim quote, no paraphrasing


### SIGNAL TYPE 5: distribution_customer
Use for: Customer acquisition, distribution channels, new segments, go-to-market strategy.

distribution_category
  new_segment        — entering a new customer demographic, geography, or product category
  revenue_segments   — revenue streams, new industries to enter, revenues to be discontinued
  channel_expansion  — adding or scaling a distribution channel
  customer_acquisition — plans for growing customer base or active users
  customer_retention — churn reduction, loyalty programs, NPS-linked investments
  partnership        — new distribution or sales partner arrangement
  product_for_segment — new product targeted at a specific segment

Fields:
  distribution_category string — from list above
  segment_or_channel    string — name of the segment, channel, or geography
  direction             "entering" | "expanding" | "exiting" | "maintaining"
  scale_metric_raw      string | null — stated size or target (e.g. "₹500 Cr opportunity")
  timeline              string | null — expected by when; null if not stated
  statement             string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 6: growth_forecast
Use for: Specific growth guidance feeding the earnings model.
Every numeric and qualitative growth statement about company revenue, margins, or key metrics must be captured.
Priority extraction — do not miss any stated or strongly implied growth rate.

Fields:
  forecast_metric      (KPI abbr for financial metrics: REV, EBITDA, PAT, EPS, ROE, NII, AUM, etc.)
                       For operational metrics not in AVAILABLE KPIs (stores, capacity, subscribers, order_book),
                       use a short descriptive label or register in new_kpis.
  guided_growth_rate   decimal | null — as a decimal (0.15 = 15%); null if only an absolute figure
  guided_absolute_value decimal | null — target absolute value; null if only a growth rate
  value_raw            string — verbatim figure (e.g. "double-digit", "15–16%", "₹10,000 Cr by FY28")
  value_unit           "%" | "Cr" | "₹" | null
  base_period          string | null — period being grown from (e.g. "FY25", "Q3FY26")
  target_period        string | null — period being grown to (e.g. "FY27", "FY28")
  confidence_level     "committed" | "aspirational" | "directional"
                         committed   — repeated or formally stated target
                         aspirational — stated once as a target
                         directional  — qualitative only
  statement            string — verbatim quote, exact words, no paraphrasing

Overlap rule: if a growth_forecast signal is also a guidance signal (same statement), emit BOTH.


### SIGNAL TYPE 7: earnings_quality
Use for: Sustainability and reliability of reported earnings.

eq_category
  cash_conversion       — operating cash flow vs. reported profits (OCF/PAT ratio)
  working_capital       — receivables stretch, inventory build, creditor compression
  one_time_item         — exceptional gain or loss distorting headline numbers
  accounting_change     — policy change, restatement, reclassification
  margin_sustainability — whether margin expansion is structural or one-time
  trend_financial       — multi-period trend in a key financial metric
  revenue_recognition   — aggressive or conservative topline recognition
  contingent_liability  — off-balance sheet exposure, guarantees, legal claims
  tax_anomaly           — effective tax rate significantly above/below statutory
  balance_sheet_health  — interest coverage, leverage targets, refinancing needs, liquidity

Fields:
  eq_category            string — from list above
  metric_affected        (KPI abbr) — use AVAILABLE KPIs; register new in new_kpis
  description            string — what is happening and why it matters (max 25 words)
  value_raw              string | null — verbatim figure if available
  impact_on_reported_earnings "overstates" | "understates" | "negative" | "positive" | null
  statement              string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 8: kpi
Use for: Reported numeric financial or operational KPIs — actual numbers for current or completed periods.
NOT guidance. NOT claims. Just the reported numbers.

Fields:
  metric          (KPI abbr) — use AVAILABLE KPIs; register new in new_kpis
  metric_family   "profitability" | "growth" | "capital" | "asset_quality" | "customer" | "industry"
  value           decimal — no units, no commas
  value_raw       string — verbatim figure exactly as stated
  unit            "Cr" | "%" | "x" | "₹" | null
  multiplier      integer — 10000000 for Crores | 100000 for Lakhs | 1 for ratios and percentages
  start_date      ISO date | null
  end_date        ISO date | null
  period_type     "quarterly" | "half_yearly" | "annual" | "ttm" | "snapshot"
  is_segment_level boolean — true if segment/subsidiary KPI, not consolidated
  segment_name    string | null — segment name if is_segment_level is true
  statement       string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 9: mgmt_tone
Use for: Overall management communication tone. Emit exactly ONE per call.

Fields:
  overall_tone     "confident" | "cautious" | "defensive" | "promotional" | "neutral"
  evidence         string[] — 2–3 specific observations supporting the tone assessment
  notable_contrast string | null — if tone shifts mid-call, describe it


### SIGNAL TYPE 10: analyst_questions
Use for: Questions asked by analysts during Q&A.

question_nature classification:
  routine     — asks for a number, update, or explanation with no negative framing
  probing     — explicitly references a negative trend, concern, or weak data point
  challenging — directly contradicts a management claim or references a gap between guidance and delivery

Fields:
  analyst_firm    string | null
  question_topic  string — short label (e.g. "NIM_trajectory", "capex_guidance")
  question_nature "routine" | "probing" | "challenging"
  statement       string — verbatim question, no paraphrasing


### SIGNAL TYPE 11: guidance_revision
Use for: Management walking back, improving, or withdrawing a prior guidance.

revision_nature: "walkdown" | "improvement" | "withdrawal"

Fields:
  prior_guidance    { metric (KPI abbr), value, period } — use AVAILABLE KPIs; register new in new_kpis
  revised_guidance  { metric (KPI abbr), value, period } | null — null if withdrawn
  actual_outcome    { metric (KPI abbr), value, period } | null — null if not yet reported
  reason            string — verbatim explanation
  revision_nature   "walkdown" | "improvement" | "withdrawal"
  statement         string — verbatim quote, no paraphrasing


### SIGNAL TYPE 12: pricing_power
Use for: Anything management says about pricing decisions, pass-through, or realization.

Fields:
  pass_through_rate  decimal | null — fraction of cost increases passed to customers (0.60 = 60%)
  pass_through_raw   string | null — verbatim figure (e.g. "60% of cost increases")
  realization_gap    string | null — description of gap between volume and price realization
  outlook            "improving" | "stable" | "declining" | null
  statement          string — verbatim quote, exact words, no paraphrasing


### SIGNAL TYPE 13: competitive_position
Use for: Management commentary on their position relative to competitors.

comparison_dimension: "pricing_power" | "cost_structure" | "distribution" | "product" | "brand" | "market_share"

Fields:
  comparison_dimension string — from list above
  relative_to          "peers" | "historical" | "market"
  direction            "improving" | "stable" | "declining"
  evidence_raw         string | null — stated data point (e.g. "gained 150bps in segment X")
  statement            string — verbatim quote, no paraphrasing

### SIGNAL TYPE 14: claim
Use for: LAST RESORT ONLY. Management assertions about past/current achievements that do not fit
any of the 13 types above.

DO NOT use claim for:
  - Reported KPI numbers → use kpi
  - Forward-looking statements → use guidance
  - Growth rates or targets → use growth_forecast
  - Earnings sustainability / quality concerns → use earnings_quality
  - Management tone / sentiment → use mgmt_tone
  - Industry or market observations → use industry_signal
  - Capital deployment decisions → use capital_allocation
  - Pricing decisions → use pricing_power
  - Competitive positioning → use competitive_position
  - Distribution / go-to-market → use distribution_customer
  - Disclosure transparency → use disclosure_quality
  - Prior guidance walkbacks → use guidance_revision
  - Analyst questions → use analyst_questions

claim_category
  financial_performance   — revenue, margins, PAT, ROE reported achievement not captured as kpi
  operational_achievement — capacity added, market share gained, products launched
  strategic_progress      — stated milestone completed
  comparative_claim       — claim relative to peers, industry, or prior period
  other

Fields:
  metric              (KPI abbr) — use AVAILABLE KPIs; register new in new_kpis
  claim_category      string — from list above
  claimed_values      Array of decimal | null — null if qualitative
  claimed_value_raw   string — verbatim figure or description
  claimed_unit        "Cr" | "%" | "x" | "₹" | null
  period_start        ISO date | null
  period_end          ISO date | null
  period_type         "quarterly" | "annual" | "ttm" | "snapshot"
  statement           string — verbatim quote, exact words, no paraphrasing


----------------------

## IMPACT & SEVERITY RULES
Assign to every signal.

impact — materiality for investment decision-making:
  "high"   — thesis-changing: major guidance cut, governance red flag, structural demand shift,
             earnings quality concern that materially affects reported profits
  "medium" — noteworthy but not thesis-changing
  "low"    — minor, confirmatory, or routine

severity — risk level:
  "critical"      — immediate action required: fraud signal, covenant breach, regulatory enforcement
  "high"          — serious risk requiring active monitoring
  "medium"        — moderate concern
  "low"           — minor concern
  "informational" — neutral or positive signal; default for all positive signals

----------------------

## EXTRACTION RULES

1. Verbatim is non-negotiable. The statement field must be the exact words from the source.
   Never paraphrase, summarize, or reword. If you cannot find the exact quote, do not create the signal.

2. The guidance vs. claim distinction is critical.
   GUIDANCE = future-facing: "we will", "we expect", "we target", "we aim", "by FY28", "next year"
   CLAIM    = present/past:  "we achieved", "we delivered", "our margins were", "we grew"
   When in doubt: if the period hasn't happened yet at call time, it is GUIDANCE.

3. growth_forecast is a priority extraction. Every numeric and qualitative growth statement must appear here.
   If it is also a guidance signal, emit BOTH — they serve different workflows.

4. No inference on numbers. If management says "double-digit growth", set guided_growth_rate: null
   and value_raw: "double-digit growth". Never impute a number that wasn't stated.

5. Segment signals stay segmented. Tag segment_name in each signal. Never roll segment data
   into consolidated signals.

6. Conditions must be captured. If guidance is conditional, set is_conditional: true and
   capture the full condition text.

7. One quote, multiple signals. If one statement contains both a growth target and a capital
   allocation plan, extract two separate signals with the same source_statement_id.

8. Before completing extraction, review kpi signals for material negatives (GNPA up, NIM
   compressing, margins declining). If any material negative appears in KPIs but management
   did not address it, create a disclosure_quality signal with
   disclosure_category: "selective_omission".

9. Do not extract: boilerplate legal disclaimers, safe harbour language, housekeeping
   announcements, timestamps, or context-free numbers without management commentary.

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly two top-level keys.
No markdown fences. No explanation. JSON only.

{
  "signals": [
    {
      "signal_id":          string,
      "source_statement_id": string,
      "source_context":     "opening_remarks" | "management_presentation" | "analyst_qa",
      "signal_type":        "guidance" | "industry_signal" | "capital_allocation" | "disclosure_quality" | "distribution_customer" | "growth_forecast" | "earnings_quality" | "kpi" | "mgmt_tone" | "analyst_questions" | "guidance_revision" | "pricing_power" | "competitive_position" | "claim",
      "impact":             "high" | "medium" | "low",
      "severity":           "critical" | "high" | "medium" | "low" | "informational",
      ...all type-specific fields for this signal_type
    }
  ],
  "new_kpis": [
    {
      "abbr":         string,
      "full_form":    string,
      "kpi_type":     "customer_kpis" | "industry_specific",
      "denomination": "rupee" | "percentage" | "ratio" | "other"
    }
  ]
}`;

// ─── Runtime data block ───────────────────────────────────────────────────────
// V2: transcript only — no PPT text. KPI reference list included same as v1.

function buildDataBlockV2(transcriptText, existingKpis, callDate, fiscalYearEnd = '03-31') {
  const kpiReference = existingKpis.map(k => {
    const denom = k.denomination ? ` [${k.denomination}]` : '';
    return `${k.abbr} — ${k.full_form}${denom}`;
  }).join('\n  ');

  return `CALL DATE: ${callDate}
FISCAL YEAR END (MM-DD): ${fiscalYearEnd}

## AVAILABLE KPIs
Use the exact abbr from this list when referencing any KPI metric in signals.
If a KPI is not listed here, add it to new_kpis and use the abbr you assign.

  ${kpiReference}

TRANSCRIPT:
${transcriptText}`;
}

function transcriptExtractorPromptV2(transcriptText, existingKpis, callDate, fiscalYearEnd = '03-31') {
  const dataBlock = buildDataBlockV2(transcriptText, existingKpis, callDate, fiscalYearEnd);
  return PROMPT_TEMPLATE_V2.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { transcriptExtractorPromptV2, buildDataBlockV2, PROMPT_TEMPLATE_V2 };
