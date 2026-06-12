'use strict';

/**
 * Annual Report signal extraction prompt (V2 schema).
 *
 * Extracts 17 signal types from Indian (NSE/BSE) annual report PDFs.
 * Output uses the SAME generic signal shape as transcript_call_v2 so signals
 * land in the same transcript_signals_v2 table.
 *
 * Key differences from transcript_call_v2 / ppt_call_v2:
 *   - source_context carries the annual report section slug (chairman_letter,
 *     ceo_letter, board_report, mda, financial_statements, notes_to_accounts,
 *     risk_section, governance_section).
 *   - signal_type set includes annual-report-specific types:
 *     financial_figure, guidance, growth_forecast, capital_allocation,
 *     risk_factor, contingent_liability, governance_signal, strategic_claim,
 *     m_and_a, kpi, leadership_statement, milestone, ongoing,
 *     industry_signal, disclosure_quality, earnings_quality, guidance_revision.
 *   - details{} carries fiscal_year, is_consolidated, and type-specific extras.
 *
 * {{DATA_BLOCK}} is replaced at runtime by buildDataBlockAr() — it contains:
 *   - AR_FY_END, PRIOR_AR_FY_END, COMPANY_NAME, NSE_SYMBOL, BSE_CODE, AR_PUBLISH_DATE
 *   - AVAILABLE KPIs list
 */

const PROMPT_TEMPLATE_AR = `QUANTCASE — ANNUAL REPORT SIGNAL EXTRACTION PROMPT

PURPOSE
Extract structured investment signals from Indian (NSE/BSE) annual reports.
Source type for all signals: "annual_report".

Identify the following structural sections before extracting:
  1. chairman_letter
  2. ceo_letter
  3. board_report
  4. mda
  5. financial_statements
  6. notes_to_accounts
  7. risk_section
  8. governance_section

Tag every signal with its section (source_context).

SECTION BOUNDARY RULES
- chairman_letter     : Letter / Message from the Chairman to shareholders.
- ceo_letter          : Managing Director's or CEO's letter / operational review, if separate from Chairman.
- board_report        : Board of Directors' Report — statutory disclosures, subsidiary details, CSR, audit
                        committee report, secretarial report.
- mda                 : Management Discussion & Analysis — operational commentary, segment performance,
                        capex review, industry outlook, risk commentary embedded in MD&A.
- financial_statements: Consolidated and standalone statements — P&L, Balance Sheet, Cash Flow Statement,
                        Statement of Changes in Equity.
- notes_to_accounts   : Notes numbered in financial statements — debt schedules, contingent liabilities,
                        related party transactions, EPS note, segment reporting note, share capital note.
- risk_section        : Dedicated risk management framework / risk factors section.
- governance_section  : Corporate Governance report — board composition, committee reports, insider
                        trading disclosures, remuneration policy, compliance certificates.
- If a section boundary is unclear, default to mda.

{{DATA_BLOCK}}

----------------------

## THE GENERIC SIGNAL SHAPE

Every signal — regardless of type — uses the SAME object shape. You do not
emit a different field-set per type. You emit the common envelope, fill the
common fields that apply, list any numeric facts in measures[], and put the
few type-specific extras in details{}.

ENVELOPE (always present)
  signal_id            unique within this run (format: AR-<TYPE_PREFIX>-<3-digit sequence>, e.g. AR-FIN-001)
  source_statement_id  links signals that came from the same passage, note, or disclosure
  source_context       "chairman_letter" | "ceo_letter" | "board_report" | "mda" |
                       "financial_statements" | "notes_to_accounts" | "risk_section" |
                       "governance_section"
  signal_type          one of the 17 types below
  impact               "high" | "medium" | "low"
  severity             "critical" | "high" | "medium" | "low" | "informational"
  statement            verbatim quote, exact words, no paraphrasing
                       (null ONLY for financial_figure signals where no quote exists)

COMMON FIELDS (fill the ones the type uses; otherwise null)
  category        the single sub-classification for this signal_type
  metric          KPI abbr (see KPI ABBREVIATION RULES)
  topic           short descriptive label (e.g. "nim_trajectory", "promoter_pledge_risk")
  description     short free-text explanation where the type asks for one
  direction       directional label — allowed values differ by type (listed per type)
  horizon         "near_term" (0–12m) | "medium_term" (1–3y) | "long_term" (3y+) | null
  timeline        free-text "when" where no precise start/end date is given
  segment_name    segment / subsidiary name — set on ANY segment-level signal
  is_segment_level true if this signal is segment/subsidiary level, not consolidated
  fiscal_year     string — fiscal year this signal primarily refers to (e.g. "FY2025")

measures[] — list of numeric facts. Use this for EVERY value/figure/unit/period.
  Each measure is:
    role        what this number is (see roles below)
    value        decimal | null — no units, no commas; null if qualitative
    value_raw    string  | null — verbatim figure exactly as stated ("₹1,245 Cr", ">20%", "double-digit")
    unit         "Cr" | "%" | "x" | "₹" | "bps" | null
    multiplier   integer | null — 10000000 for Crores | 100000 for Lakhs | 1 for ratios/percentages
    period       { start, end, type } | null
                   start / end : ISO YYYY-MM-DD | null
                   type        : "annual" | "half_yearly" | "quarterly" | "snapshot" |
                                 "guidance" | "target" | "cumulative" | null

  measure ROLES:
    reported          a reported/actual figure for a completed period
    guided            a forward-looking guided figure
    baseline          the current/base figure a guidance is measured from
    prior             prior-period figure (for YoY comparisons)
    growth_rate       a stated growth rate (store as decimal: 0.15 = 15%)
    absolute_target   a guided absolute target value
    quantum           an amount of capital being allocated or deployed
    scale             a stated opportunity size or market-size figure
    contingent        an unaccrued contingency / claim amount
    accrued           an amount already provisioned in P&L or notes
    milestone         a figure management states as already achieved
    revised           a revised guidance vs prior year guidance
    actual            the realised outcome matched against a prior guidance
    pass_through      fraction of cost increases passed to customers (0.60 = 60%)

details{} — type-specific extras only (open object). Keys listed per type.
  Do NOT put values, units, or periods here — those always go in measures[].

----------------------

## DATE FORMATTING RULES

- All dates must be in YYYY-MM-DD format.
- Use AR_FY_END as the reference point for all relative date calculations.
- Resolve all vague periods to the LAST DAY of the implied period:
  - "FY2025"         → start: 2024-04-01  end: 2025-03-31
  - "H1 FY25"        → start: 2024-04-01  end: 2024-09-30
  - "Q3 FY25"        → start: 2024-10-01  end: 2024-12-31
  - "next year"      → 12 months from AR_FY_END
  - "next 2–3 years" → 36 months from AR_FY_END
  - "near term"      → 12 months from AR_FY_END
  - "medium term"    → 36 months from AR_FY_END
  - "long term"      → 60 months from AR_FY_END
- If truly unresolvable, use null.

----------------------

## KPI ABBREVIATION RULES

1. Always check AVAILABLE KPIs first. Use the exact abbr from that list.
2. If the metric is not in the list — add it to new_kpis and use the abbr you assign there.
3. KPI abbrs are TIMELESS — never embed a period or fiscal year in the abbr.
   Use REV not REV_FY25; use EBITDA not EBITDA_FY25.
4. Segment KPIs: prefix with SEG_<SEGMENT>_<ABBR> (e.g. SEG_RETAIL_REV).
   Always register in new_kpis if not in AVAILABLE KPIs.
5. Standard financial statement abbreviations (always available; do NOT re-register):
   REV, EBITDA, EBIT, D_A, FINANCE_COSTS, PBT, TAX_EXP, PAT, PAT_MARGIN, EPS_BASIC, EPS_DIL,
   DPS, TOTAL_ASSETS, TOTAL_EQUITY, TOTAL_DEBT, LT_DEBT, ST_DEBT, NET_DEBT, CASH, TRADE_REC,
   INVENTORY, TRADE_PAY, OCF, CAPEX, FCF, DIVIDEND_PAID, ROE, ROCE, ROA,
   CURRENT_RATIO, QUICK_RATIO, DE_RATIO, NET_DE_RATIO, DEBT_EBITDA, NET_DEBT_EBITDA,
   INTEREST_COVERAGE, ASSET_TURNOVER, INV_TURNOVER, REC_TURNOVER, PAY_TURNOVER, DIO, DSO, DPO, CCC.

----------------------

## SIGNAL TYPES

Every signal must have: signal_id, source_statement_id, source_context, impact, and severity.
One disclosure can emit multiple signals — link them with the same source_statement_id.


### SIGNAL TYPE 1: financial_figure

Use for: Numeric data from P&L, Balance Sheet, Cash Flow Statement, Segment Reporting,
or per-share disclosures where the primary signal is a reported financial line item.

MULTI-PERIOD RULE: Extract all disclosed periods. Emit one measure per period
(role=reported for current year, role=prior for prior years).

category: "income_statement" | "balance_sheet" | "cash_flow" | "segment_reporting" | "ratios" | "per_share"
metric:   yes (KPI abbr from standard list)
statement: null (financial statement line items have no narrative quote)
measures: role=reported (current year) + role=prior (prior year/s)
details:
  financial_year    (string — "FY2025")
  is_consolidated   (boolean — true if consolidated, false if standalone)
  accounting_note   (string | null — note reference if qualification applies)
  is_adjusted       (boolean — true if figure has been adjusted by management)


### SIGNAL TYPE 2: guidance

Use for: Forward-looking TARGETS or COMMITMENTS explicitly stated that have a future
delivery not yet realised. Tense check: "will", "expect to", "targeting", "planning to".

category: "timebound_guidance" | "open_ended_guidance"
metric:   yes (KPI abbr)
measures: role=guided (value, value_raw, unit, period{type="guidance"}) ;
          role=baseline (current base if stated alongside)
details:
  is_conditional  (boolean)
  condition       (string | null)


### SIGNAL TYPE 3: growth_forecast

Use for: Specific growth guidance for revenue, margins, volumes, or key metrics.
If a statement qualifies as both guidance and growth_forecast, emit BOTH signals.

metric:    yes — KPI abbr for the metric being forecast
direction: set when qualitative; null if numeric measure covers it
horizon:   yes
measures:  role=growth_rate (value as decimal, 0.15=15%; unit="%") ;
           role=absolute_target (value; value_raw; unit)
details:
  confidence_level ("committed" | "aspirational" | "directional")


### SIGNAL TYPE 4: capital_allocation

Use for: Statements on HOW capital is being or will be deployed — capex plans,
dividend policy, debt repayment, buyback announcements, or treasury strategy.

category: "capex" | "dividend" | "debt_reduction" | "buyback" | "working_capital" |
          "acquisition_funding" | "r_and_d" | "other"
metric:    yes (KPI abbr)
measures:  role=quantum ; role=guided (if forward-looking) ; role=baseline
direction: "increase" | "decrease" | "maintain" | "redeploy" | null
details:
  source_of_funds   (string | null)
  capex_purpose     (string | null)
  return_target     (string | null)


### SIGNAL TYPE 5: risk_factor

Use for: Risks explicitly identified in the Risk Management section, MD&A risk
commentary, or Board Report. Extract every disclosed risk.

category: "market_risk" | "operational_risk" | "regulatory_risk" | "financial_risk" |
          "strategic_risk" | "esg_risk" | "technology_risk" | "concentration_risk" |
          "geopolitical_risk" | "other"
direction: "increasing" | "decreasing" | "stable" | null
measures:  [if risk has a quantified exposure — role=quantum]
details:
  mitigation_stated    (boolean)
  mitigation_summary   (string | null)
  risk_owner           (string | null)


### SIGNAL TYPE 6: contingent_liability

Use for: Unaccrued legal claims, tax disputes, regulatory penalties, financial guarantees,
and other contingent obligations from Notes to Accounts. ALWAYS extract regardless of amount.

category: "tax_dispute" | "legal_claim" | "regulatory_penalty" | "guarantee" |
          "environmental_claim" | "labour_dispute" | "other"
measures: role=contingent (total unaccrued amount) ; role=accrued (provisioned amount)
details:
  dispute_description  (string — verbatim from notes)
  forum                (string | null)
  period_of_dispute    (string | null)
  company_position     (string | null)
  related_party        (boolean)


### SIGNAL TYPE 7: governance_signal

Use for: Director changes, audit qualifications, related party disclosures, promoter
pledging, insider transactions, or committee observations. Priority: always extract
if auditor qualification, promoter pledge, or KMP change is present.

category: "board_composition" | "audit_qualification" | "related_party" |
          "promoter_pledging" | "insider_transaction" | "committee_observation" |
          "kmp_change" | "dividend_waiver" | "other"
direction: "positive" | "negative" | "neutral" | null
measures:  role=reported (quantified disclosures)
details:
  party_name      (string | null)
  nature_of_txn   (string | null)
  approval_status (string | null)
  auditor_name    (string | null)
  is_arms_length  (boolean | null)


### SIGNAL TYPE 8: strategic_claim

Use for: Management assertions of competitive advantages, moat, or market positioning.
Extract exactly as stated — do NOT validate or endorse these claims.
REJECT boilerplate: "committed to quality", "customer-centric approach".

category: "competitive_moat" | "brand_strength" | "technology_leadership" |
          "distribution_advantage" | "cost_leadership" | "regulatory_moat" |
          "customer_captivity" | "scale_advantage" | "other"
details:
  evidence_cited  (string | null)
  claim_type      ("explicit" | "implicit")


### SIGNAL TYPE 9: m_and_a

Use for: Disclosed acquisitions, divestments, mergers, joint ventures, or material
asset deals. If no M&A activity is disclosed, do NOT emit this type.

category: "acquisition" | "divestment" | "merger" | "joint_venture" | "asset_purchase" |
          "asset_sale" | "stake_acquisition" | "other"
measures: role=quantum (deal value if stated)
details:
  target_name          (string)
  deal_status          ("completed" | "pending_approval" | "announced" | "integrated")
  strategic_rationale  (string | null)
  deal_structure       (string | null)
  goodwill_created     (string | null)
  synergy_target       (string | null)
  integration_status   (string | null)
  revenue_contribution (string | null)


### SIGNAL TYPE 10: kpi

Use for: Operational KPIs in MD&A, KPI dashboards, segment commentary, or Board Report
that are NOT direct P&L / Balance Sheet / Cash Flow line items.
Examples: store count, capacity utilisation, fleet utilisation, market share %, order book.

category: "operating_efficiency" | "capacity" | "customer" | "distribution" |
          "quality" | "esg" | "volume" | "market_share" | "order_book" | "other"
metric:       yes (KPI abbr)
is_segment_level: true if segment KPI
measures:     role=reported (current year) ; role=prior (prior year if disclosed)
details:
  kpi_definition  (string | null)
  target          (string | null)


### SIGNAL TYPE 11: leadership_statement

Use for: Material commitments, performance acknowledgements, or governance commentary
in Chairman / CEO / MD letters that represent investable signals.
REJECT generic promotionals and statements already captured in other types.

ACCEPT: explicit underperformance acknowledgements, commitment to a specific strategic
shift, capital allocation priority declared, competitive/operational challenge admitted.

category: "performance_acknowledgement" | "strategic_commitment" |
          "capital_allocation_signal" | "governance_commentary" |
          "competitive_acknowledgement" | "other"
details:
  author_name  (string)
  author_role  ("chairman" | "ceo" | "md" | "executive_chairman" | "other")


### SIGNAL TYPE 12: milestone

Use for: Completed achievements explicitly stated — results, records, accomplishments
for the period under review. Past tense / present perfect only.
REJECT raw financial line items (use financial_figure) and forward plans (use guidance).

category: "financial_performance" | "operational_achievement" | "strategic_progress" |
          "comparative_milestone" | "governance_milestone" | "other"
metric:   yes (KPI abbr)
measures: role=milestone (the achieved figure) ; role=prior (comparison figure if stated)
details:
  achievement_context  (string | null)


### SIGNAL TYPE 13: ongoing

Use for: Initiatives currently in progress. Triggered by "we are", "we continue",
"currently", "in the process of". REJECT boilerplate and completed initiatives.

category: "timebound" | "open_ended"
metric:   yes
topic:    yes (short initiative label)
measures: role=quantum ; role=scale
details:
  initiative_name    (string | null)
  completion_target  (string | null)
  current_progress   (string | null)


### SIGNAL TYPE 14: industry_signal

Use for: Commentary on industry structure, market size, demand drivers, competitive
dynamics, or macroeconomic context. Management's view of the external environment.
REJECT third-party projections without management endorsement.

category: "demand_environment" | "supply_dynamics" | "competitive_intensity" |
          "regulatory_change" | "macro_tailwind" | "macro_headwind" |
          "pricing_environment" | "technology_disruption" | "export_import" | "other"
direction: "positive" | "negative" | "neutral" | "uncertain"
horizon:   yes
measures:  role=scale (market size) ; role=growth_rate (industry growth rate)
details:
  market_name   (string | null)
  data_source   (string | null)
  drivers       (string[] — up to 5 key phrases)


### SIGNAL TYPE 15: disclosure_quality

Use for: Signals where management chose NOT to disclose, disclosures appear incomplete,
or current-year reporting changed materially vs prior year without explanation.
PRIORITY TRIGGERS: segment removed, prior-year restatement, KPI now absent,
auditor qualification, RPT materially incomplete, round-number revenue lines.

category: "segment_discontinuity" | "restatement" | "kpi_withdrawal" |
          "smoothing_signal" | "audit_observation" | "rpt_concern" |
          "goodwill_concern" | "policy_change" | "other"
direction: "negative" | "neutral"
details:
  prior_disclosure   (string | null)
  current_status     (string | null)
  concern_rationale  (string — required)
  l2_flag            (boolean — always true)


### SIGNAL TYPE 16: earnings_quality

Use for: Signals about sustainability and reliability of reported earnings.

category: "cash_conversion" | "working_capital" | "one_time_item" | "accounting_change" |
          "margin_sustainability" | "revenue_recognition" | "tax_anomaly" |
          "balance_sheet_stress" | "related_party_revenue" | "other"
metric:      yes
description: yes (what is happening and why it matters; max 25 words)
direction:   "improving" | "deteriorating" | "stable" | "uncertain"
measures:    role=current ; role=prior
details:
  impact_on_reported_earnings ("overstates" | "understates" | "negative" | "positive" | null)
  l2_flag                     (boolean)


### SIGNAL TYPE 17: guidance_revision

Use for: Where current-year actual performance can be compared against guidance given
in the PRIOR year's annual report. Tracks management's guidance delivery track record.
REQUIRES PRIOR_AR_FY_END to be set. Do not emit if prior guidance cannot be confirmed.

category: "delivery_met" | "delivery_missed" | "delivery_exceeded" | "guidance_withdrawn"
metric:   yes
measures: role=guided (prior-year guidance) ; role=actual (this year's realised outcome)
details:
  prior_guidance_source  (string)
  variance_description   (string)
  management_explanation (string | null)
  prior_guidance_quoted  (boolean)

----------------------

## IMPACT & SEVERITY RULES

impact — materiality for investment decision-making:
  "high"   — thesis-changing: governance red flag, structural shift, large contingency,
             guidance miss, earnings quality concern materially affecting reported profits
  "medium" — noteworthy, affects monitoring or valuation, but not immediately thesis-changing
  "low"    — confirmatory, routine, minor, or informational

severity — risk level:
  "critical"      — immediate action required: auditor qualification, covenant breach,
                    large promoter pledge, fraud signal, material restatement
  "high"          — serious risk requiring active monitoring
  "medium"        — moderate concern
  "low"           — minor concern
  "informational" — neutral or positive signal; default for all positive signals

SEVERITY ESCALATION RULES:
  - governance_signal with audit_qualification or promoter_pledging → minimum "critical"
  - contingent_liability > ₹100 Cr AND adverse outcome possible → minimum "high"
  - disclosure_quality signal with l2_flag=true → minimum "high"
  - guidance_revision with category=delivery_missed on revenue or PAT → minimum "high"

----------------------

## EXTRACTION RULES

1. Verbatim is non-negotiable. statement = exact words from source. Never paraphrase.
   Exception: financial_figure (statement=null permitted).

2. Source integrity. Extract each section separately with the correct source_context.
   Do NOT merge signals from different sections into one signal.

3. No fabrication. If a figure is not disclosed, do NOT estimate or infer.
   If the omission is material, log a disclosure_quality signal instead.

4. No inference. Do NOT derive risk severity or guidance credibility. L1 extracts. L2 interprets.

5. Segment signals stay segmented. Set segment_name and is_segment_level: true on every
   segment-level signal. Never roll up segment data into a consolidated signal.

6. financial_figure is multi-period. Extract all disclosed periods.
   One measure per period. Each measure has its own period object.

7. Governance signals are priority. Always extract auditor qualifications, promoter pledge
   changes, any RPT disclosure, and KMP changes regardless of amount.

8. Conditions must be captured. If guidance is conditional, set details.is_conditional: true
   and capture the full condition text in details.condition.

9. One disclosure → multiple signals permitted. A single paragraph containing a capex
   announcement, guidance, and milestone should emit three signals with the same source_statement_id.

10. Disclosure quality monitoring. When any signal section present in a prior year
    annual report is absent or materially changed without explanation, emit a disclosure_quality signal.
    Mandatory check for: segment disclosures, contingent liabilities, RPTs, MD&A KPIs.

11. Do not extract: generic mission / vision / values boilerplate, ESG aspirations without
    metrics, safe harbour disclaimers, routine board resolution summaries, section headers.

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly two top-level keys.
No markdown fences. No explanation. JSON only.

{
  "signals": [
    {
      "signal_id":           string,
      "source_statement_id": string,
      "source_context":      "chairman_letter" | "ceo_letter" | "board_report" | "mda" |
                             "financial_statements" | "notes_to_accounts" | "risk_section" |
                             "governance_section",
      "signal_type":         "financial_figure" | "guidance" | "growth_forecast" |
                             "capital_allocation" | "risk_factor" | "contingent_liability" |
                             "governance_signal" | "strategic_claim" | "m_and_a" | "kpi" |
                             "leadership_statement" | "milestone" | "ongoing" |
                             "industry_signal" | "disclosure_quality" | "earnings_quality" |
                             "guidance_revision",
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
      "fiscal_year":         string | null,

      "measures": [
        {
          "role":       string,
          "value":      number | null,
          "value_raw":  string | null,
          "unit":       "Cr" | "%" | "x" | "₹" | "bps" | null,
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
      "kpi_type":     "financial" | "operational" | "customer" | "esg" | "governance" | "industry_specific",
      "denomination": "rupee" | "percentage" | "ratio" | "count" | "other"
    }
  ]
}`;

// ─── Runtime data block ───────────────────────────────────────────────────────

function buildDataBlockAr(existingKpis, arFyEnd, priorArFyEnd, companyName, nseSymbol, bseCode, arPublishDate) {
  const kpiReference = existingKpis.map(k => {
    const denom = k.denomination ? ` [${k.denomination}]` : '';
    return `${k.abbr} — ${k.full_form}${denom}`;
  }).join('\n  ');

  return `AR_FY_END       : ${arFyEnd ?? 'unknown'}
PRIOR_AR_FY_END : ${priorArFyEnd ?? 'unknown'}
COMPANY_NAME    : ${companyName ?? 'unknown'}
NSE_SYMBOL      : ${nseSymbol ?? 'unknown'}
BSE_CODE        : ${bseCode ?? 'unknown'}
AR_PUBLISH_DATE : ${arPublishDate ?? 'unknown'}

## AVAILABLE KPIs
Use the exact abbr from this list when referencing any KPI metric in signals.
If a KPI is not listed here, add it to new_kpis and use the abbr you assign.

  ${kpiReference}`;
}

function annualReportExtractorPromptV2(existingKpis, arFyEnd, priorArFyEnd, companyName, nseSymbol, bseCode, arPublishDate) {
  const dataBlock = buildDataBlockAr(existingKpis, arFyEnd, priorArFyEnd, companyName, nseSymbol, bseCode, arPublishDate);
  return PROMPT_TEMPLATE_AR.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { annualReportExtractorPromptV2, buildDataBlockAr, PROMPT_TEMPLATE_AR };
