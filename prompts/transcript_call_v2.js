'use strict';

/**
 * V2 transcript extraction prompt.
 *
 * Change vs original: 14 bespoke field-sets collapsed into ONE generic signal shape
 * (envelope + promoted common fields + measures[] + details{}).
 * All extraction guidelines preserved unchanged.
 *
 * signal_type rename: company_growth_forecast → growth_forecast
 *
 * {{DATA_BLOCK}} is replaced at runtime by buildDataBlockV2() — it contains:
 *   - CALL DATE / FISCAL YEAR END
 *   - AVAILABLE KPIs list (for dedup — same flow as before)
 *   - TRANSCRIPT text
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

## THE GENERIC SIGNAL SHAPE

Every signal — regardless of type — uses the SAME object shape. You do not
emit a different field-set per type. You emit the common envelope, fill the
common fields that apply, list any numeric facts in \`measures[]\`, and put the
few type-specific extras in \`details{}\`.

ENVELOPE (always present)
  signal_id            unique within this run
  source_statement_id  links signals that came from the same statement
  source_context       "opening_remarks" | "management_presentation" | "analyst_qa"
  signal_type          one of the 14 types below
  impact               "high" | "medium" | "low"            (see IMPACT & SEVERITY RULES)
  severity             "critical" | "high" | "medium" | "low" | "informational"
  statement            verbatim quote, exact words, no paraphrasing (null only where a type permits)

COMMON FIELDS (fill the ones the type uses; otherwise null)
  category        the single sub-classification for this signal_type (the allowed
                  values are listed under each type — this replaces the old
                  guidance_category / industry_category / eq_category / claim_category /
                  comparison_dimension / question_nature / revision_nature / dominant_tone, etc.)
  metric          KPI abbr (see KPI ABBREVIATION RULES) where the type names a metric
  topic           short descriptive label (e.g. "housing_demand_recovery", "NIM_trajectory")
  description     short free-text explanation where the type asks for one
  direction       directional label — allowed VALUES DIFFER BY TYPE (listed per type)
  horizon         "near_term" (0–12m) | "medium_term" (1–3y) | "long_term" (3y+) | null
  timeline        free-text "when" where no precise start/end date is given
  segment_name    segment / subsidiary name — set on ANY segment-level signal, not just KPIs
  is_segment_level true if this signal is segment/subsidiary level, not consolidated

measures[] — list of numeric facts. Use this for EVERY value/figure/unit/period.
  Each measure is:
    role        what this number is (see roles below)
    value        decimal | null — no units, no commas; null if qualitative
    value_raw    string  | null — verbatim figure exactly as spoken ("double-digit", "15–16%")
    unit         "Cr" | "%" | "x" | "₹" | null
    multiplier   integer | null — 10000000 for Crores | 100000 for Lakhs | 1 for ratios/percentages
    period       { start, end, type } | null
                   start / end : ISO YYYY-MM-DD (apply DATE FORMATTING RULES) | null
                   type        : "quarterly" | "half_yearly" | "annual" | "ttm" |
                                 "snapshot" | "guidance" | "base" | "target" | null

  measure ROLES (pick the role that names the number):
    reported          a reported/actual KPI number for a completed period
    guided            a forward-looking guided figure
    baseline          the current/base figure a guidance is measured from
    value             a generic market/industry figure
    quantum           an amount of capital being deployed
    scale             a stated opportunity/target size
    growth_rate       a guided growth rate (store as decimal: 0.15 = 15%)
    absolute_target   a guided absolute target value
    current           current-period figure (earnings-quality comparisons)
    prior             prior-period / base figure
    revised           a revised guidance figure
    actual            the realized outcome of a prior guidance
    claimed           a figure management claims as already achieved
    pass_through      fraction of cost increases passed to customers (0.60 = 60%)

details{} — type-specific extras only (open object). Keys are listed per type.
  Do NOT put values, units, or periods here — those always go in measures[].

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
These rules apply to every \`metric\` field and to any measure that references a metric.

1. Always check AVAILABLE KPIs first. Use the exact abbr from that list.
2. If the metric is not in the list → add it to new_kpis and use the abbr you assign there.
3. KPI abbrs are TIMELESS — never embed a period, quarter, or fiscal year in the abbr.
   Use REV not REV_Q3; use EBITDA not EBITDA_9M; use PAT not PAT_FY25.
   Time belongs in the measure's period.start / period.end.
4. Segment KPIs: prefix with SEG_<SEGMENT>_<ABBR> (e.g. SEG_RETAIL_REV).
   Always register in new_kpis if not in AVAILABLE KPIs.
5. Company-prefixed (JAI_EBITDA) and unprefixed (EBITDA) represent the same metric.
   Check both forms before registering a new one.

----------------------

## SIGNAL TYPES

Every signal must have: signal_id, source_statement_id, source_context, impact,
and severity. One statement can emit multiple signals — link them with the same
source_statement_id. Example: if one statement contains both a growth target and
a capital allocation plan, extract two separate signals (two rows) with the same
source_statement_id and different signal_id.

For each type below: \`category\` values are the allowed sub-classifications;
listed measure roles are the numbers to emit; listed details keys are the only
type-specific extras.


### SIGNAL TYPE 1: guidance
Use for: Any forward-looking statement about the future, made by management only.
Don't include analyst or third-party future statements. Don't include anything
already achieved, currently achieved, or already in place.

category: "quantitative" | "qualitative_directional" | "timeline_milestone"
  quantitative            — specific number, range, or ratio ("15–16% margins", "₹5,000 Cr revenue")
  qualitative_directional — directional but no number ("margins will improve")
  timeline_milestone      — event expected by a specific date or period
metric:   yes (KPI abbr)
measures: role=guided  (value, value_raw, unit, period{start,end}) ;
          role=baseline (value_raw) if a current/base value is stated
details:  is_conditional (boolean — true if guidance depends on an external condition),
          condition (string | null — the stated condition; null if not conditional)


### SIGNAL TYPE 2: industry_signal
Use for: Market-level insights — not company-specific. Demand trends, supply dynamics,
competitive moves, M&A activity, regulatory changes. Extract even when mentioned in passing.

category: "demand" | "supply" | "competition" | "ma_activity" | "regulatory" | "global" | "macro"
  demand      — end-market demand drivers, growth rates, structural tailwinds/headwinds
  supply      — capacity additions, input cost trends, supply constraints
  competition — market share shifts, new entrants, pricing pressure, peer performance
  ma_activity — acquisitions, divestments, consolidation in the sector
  regulatory  — policy changes, compliance requirements, incentives, restrictions
  global      — export/import dynamics, other countries impacting the industry
  macro       — GDP, credit growth, interest rates, currency — only when linked to business
topic:     yes (short label, e.g. "steel_capacity_glut")
direction: "positive" | "negative" | "neutral" | "uncertain"
horizon:   yes
measures:  role=value (value, value_raw, unit) if a figure is stated
details:   drivers (string[] — up to 5 driver phrases, max 8 words each)


### SIGNAL TYPE 3: capital_allocation
Use for: How management is deploying capital — where it goes, return expectations, timeline.

category: "capex" | "ma" | "debt_management" | "shareholder_returns" | "r_and_d"
  capex               — expansion, maintenance, new facilities, technology
  ma                  — acquisitions, divestments, JVs, stake purchases/sales
  debt_management     — fresh borrowings, repayments, refinancing, leverage targets
  shareholder_returns — dividends, buybacks, payout ratio guidance
  r_and_d             — product, brand, or technology investment
description: yes (what is being allocated, max 20 words)
timeline:    yes (when deployed; null if not stated)
measures:    role=quantum (value, value_raw e.g. "₹2,000 Cr over 3 years", unit)
details:     return_expectation (string | null — stated return metric; null if not stated)


### SIGNAL TYPE 4: disclosure_quality
Use for: How management handles bad news.
Central question: is management proactively transparent, or do they only admit problems when pressed?

category: "proactive_bad_news" | "reactive_bad_news" | "proactive_good_news" |
          "selective_omission" | "auditor_or_regulatory_flag" | "key_mgmt_change"
  proactive_bad_news         — management volunteers a negative without being asked
  reactive_bad_news          — management acknowledges an issue only when directly questioned
  proactive_good_news        — management highlights a genuine positive
  selective_omission         — material negative visible in KPIs but not addressed by management
  auditor_or_regulatory_flag — SEBI/regulatory action, auditor comments, or legal acts
  key_mgmt_change            — management changes / key person risk (CFO departure, new CEO, promoter pledge, etc.)
topic:    yes (what is being disclosed, e.g. "NIM compression", "order book slippage")
statement: may be null
details:  trigger ("unsolicited" | "analyst_question" | "inferred_from_data"),
          management_framing (string — one sentence: how management described/framed this),
          severity_of_issue ("critical" | "high" | "medium" | "low" — the underlying
            business issue; this is SEPARATE from the envelope \`severity\`)


### SIGNAL TYPE 5: distribution_customer
Use for: Customer acquisition, distribution channels, new segments, go-to-market strategy.

category: "new_segment" | "revenue_segments" | "channel_expansion" |
          "customer_acquisition" | "customer_retention" | "partnership" | "product_for_segment"
  new_segment          — entering a new customer demographic, geography, or product category
  revenue_segments     — revenue streams, new industries to enter, revenues to be discontinued
  channel_expansion    — adding or scaling a distribution channel
  customer_acquisition — plans for growing customer base or active users
  customer_retention   — churn reduction, loyalty programs, NPS-linked investments
  partnership          — new distribution or sales partner arrangement
  product_for_segment  — new product targeted at a specific segment
topic:     yes (name of the segment, channel, or geography)
direction: "entering" | "expanding" | "exiting" | "maintaining"
timeline:  yes (expected by when; null if not stated)
measures:  role=scale (value_raw — stated size/target, e.g. "₹500 Cr opportunity")


### SIGNAL TYPE 6: growth_forecast
Use for: Specific growth guidance feeding the earnings model.
Every numeric and qualitative statement about future growth of company revenue,
margins, or key metrics must be captured. Priority extraction — do not miss any
stated or strongly implied growth rate.

metric:   yes — KPI abbr for financial metrics (REV, EBITDA, PAT, EPS, ROE, NII, AUM, …).
          For operational metrics not in AVAILABLE KPIs (stores, capacity, subscribers,
          order_book), use a short descriptive label or register in new_kpis.
measures: role=growth_rate (value as decimal, 0.15 = 15%; value_raw; unit) — null value if only an absolute figure ;
          role=absolute_target (value; value_raw; unit) — null value if only a growth rate ;
          use period.type="base" for the period being grown FROM and
              period.type="target" for the period being grown TO.
details:  confidence_level ("committed" | "aspirational" | "directional")
            committed    — repeated or formally stated target
            aspirational — stated once as a target
            directional  — qualitative only

Overlap rule: if a growth_forecast signal is also a guidance signal (same statement), emit BOTH.


### SIGNAL TYPE 7: earnings_quality
Use for: Sustainability and reliability of reported earnings. Capture all statements
containing numeric and qualitative data regarding the categories below.

category: "cash_conversion" | "working_capital" | "one_time_item" | "accounting_change" |
          "margin_sustainability" | "trend_financial" | "revenue_recognition" |
          "contingent_liability" | "tax_anomaly" | "balance_sheet_health"
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
metric:      yes (the metric affected; KPI abbr)
description: yes (what is happening and why it matters, max 25 words)
direction:   "improving" | "deteriorating" | "stable" | "uncertain"   (the trend)
measures:    role=current (value, value_raw) ; role=prior (value, value_raw)
details:     impact_on_reported_earnings ("overstates" | "understates" | "negative" | "positive" | null)


### SIGNAL TYPE 8: kpi
Use for: Reported numeric financial or operational KPIs — actual numbers for current
or completed periods. NOT guidance. Just the reported and claimed numbers.

metric:           yes (KPI abbr)
is_segment_level: true if segment/subsidiary KPI, not consolidated
segment_name:     segment name if is_segment_level is true
measures:         role=reported (value, value_raw, unit, multiplier,
                  period{start, end, type="quarterly"|"half_yearly"|"annual"|"ttm"|"snapshot"})
details:          metric_family ("profitability" | "growth" | "capital" | "asset_quality" |
                    "customer" | "order_pipeline" | "industry")


### SIGNAL TYPE 9: mgmt_tone
Use for: Overall management communication tone. Emit one dominant tone plus any
notable contrast if tone shifts during the call.

category: "confident" | "cautious" | "defensive" | "promotional" | "neutral"   (the dominant tone)
details:  evidence (string[] — 2–3 verbatim observations supporting the dominant tone),
          notable_contrast (object | null — null if tone is consistent; if tone shifts:
            {
              "exists":            boolean,
              "primary_tone":      "confident" | "cautious" | "defensive" | "promotional" | "neutral",
              "contrasting_tone":  "confident" | "cautious" | "defensive" | "promotional" | "neutral",
              "primary_topic":     string — topic on which dominant tone was observed,
              "contrasting_topic": string — topic that triggered the tone shift,
              "statement":         string — verbatim quote best evidencing the contrasting tone
            })


### SIGNAL TYPE 10: analyst_questions
Use for: Questions asked by analysts only during Q&A.

category: "routine" | "probing" | "challenging"   (the question nature)
  routine     — asks for a number, update, or explanation with no negative framing
  probing     — explicitly references a negative trend, concern, or weak data point
  challenging — directly contradicts a management claim or references a gap between guidance and delivery
topic:     yes (short label, e.g. "NIM_trajectory", "capex_guidance")
statement: yes — verbatim question, no paraphrasing
details:   analyst_firm (string | null)


### SIGNAL TYPE 11: guidance_revision
Use for: Management walking back, improving, or withdrawing a prior guidance.

category: "walkdown" | "improvement" | "withdrawal"   (the revision nature)
metric:   yes (KPI abbr — the metric being revised)
measures: role=prior   (value, period{type}) — the prior guidance ;
          role=revised (value, period{type}) — omit if withdrawn ;
          role=actual  (value, period{type}) — omit if not yet reported
details:  reason (string — verbatim explanation)


### SIGNAL TYPE 12: pricing_power
Use for: Anything management says about pricing decisions, pass-through, or realization.

measures: role=pass_through (value as decimal 0.60 = 60%, value_raw e.g. "60% of cost increases")
details:  realization_gap (string | null — gap between volume and price realization),
          outlook ("improving" | "stable" | "declining" | null)


### SIGNAL TYPE 13: competitive_position
Use for: Management commentary on their position relative to competitors.

category: "pricing_power" | "cost_structure" | "distribution" | "product" | "brand" | "market_share"
direction: "improving" | "stable" | "declining"
details:   relative_to ("peers" | "historical" | "market"),
           evidence_raw (string | null — stated data point, e.g. "gained 150bps in segment X")


### SIGNAL TYPE 14: claim
Use for: Management assertions about already-achieved/past and current achievements.
These are management's statements about their own performance — nothing about the future.

category: "financial_performance" | "operational_achievement" | "strategic_progress" |
          "comparative_claim" | "other"
  financial_performance   — revenue, margins, PAT, ROE reported achievement not captured as kpi
  operational_achievement — capacity added, market share gained, products launched
  strategic_progress      — stated milestone completed
  comparative_claim       — claim relative to peers, industry, or prior period
  other
metric:   yes (KPI abbr)
measures: one role=claimed per claimed number (value; value_raw; unit;
          period{start, end, type="quarterly"|"annual"|"ttm"|"snapshot"}).
          If management claims several figures, emit several \`claimed\` measures.

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

4. No inference on numbers. If management says "double-digit growth", set the measure's
   value: null and value_raw: "double-digit growth". Never impute a number that wasn't stated.

5. Segment signals stay segmented. Set segment_name (and is_segment_level where applicable)
   on each signal. Never roll segment data into consolidated signals.

6. Conditions must be captured. If guidance is conditional, set details.is_conditional: true
   and capture the full condition text in details.condition.

7. Before completing extraction, review kpi signals for material negatives (GNPA up, NIM
   compressing, margins declining). If any material negative appears in KPIs but management
   did not address it, create a disclosure_quality signal with category: "selective_omission".

8. Do not extract: boilerplate legal disclaimers, safe harbour language, housekeeping
   announcements, timestamps, or context-free numbers without management commentary.

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly two top-level keys.
No markdown fences. No explanation. JSON only.

{
  "signals": [
    {
      "signal_id":           string,
      "source_statement_id": string,
      "source_context":      "opening_remarks" | "management_presentation" | "analyst_qa",
      "signal_type":         "guidance" | "industry_signal" | "capital_allocation" |
                             "disclosure_quality" | "distribution_customer" | "growth_forecast" |
                             "earnings_quality" | "kpi" | "mgmt_tone" | "analyst_questions" |
                             "guidance_revision" | "pricing_power" | "competitive_position" | "claim",
      "impact":              "high" | "medium" | "low",
      "severity":            "critical" | "high" | "medium" | "low" | "informational",
      "statement":           string | null,

      "category":            string | null,
      "metric":              string | null,
      "topic":               string | null,
      "description":         string | null,
      "direction":           string | null,
      "horizon":             "near_term" | "medium_term" | "long_term" | null,
      "timeline":            string | null,
      "segment_name":        string | null,
      "is_segment_level":    boolean | null,

      "measures": [
        {
          "role":       string,
          "value":      number | null,
          "value_raw":  string | null,
          "unit":       "Cr" | "%" | "x" | "₹" | null,
          "multiplier": number | null,
          "period":     { "start": string|null, "end": string|null, "type": string|null } | null
        }
      ],

      "details": { }
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
