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

BEFORE EXTRACTION: Ensure the following context is available:
AR_FY_END      : Fiscal year end date (format: YYYY-03-31 for March year-end; adjust for other cycles)
COMPANY_NAME   : Legal name as printed on the annual report cover
NSE_SYMBOL     : NSE ticker symbol
BSE_CODE       : BSE stock code
AR_PUBLISH_DATE: Date annual report was filed or published (YYYY-MM-DD)
PRIOR_AR_FY_END: Prior fiscal year end (YYYY-03-31) — required for guidance_revision signals

{{DATA_BLOCK}}

----------------------

## THE GENERIC SIGNAL SHAPE

Every signal — regardless of type — uses the SAME object shape. You do not
emit a different field-set per type. You emit the common envelope, fill the
common fields that apply, list any numeric facts in "measures[]", and put the
few type-specific extras in "details{}".

ENVELOPE (always present)
  signal_id            unique within this run (format: AR-<TYPE_PREFIX>-<3-digit sequence>, e.g. AR-FIN-001)
  source_statement_id  links signals that came from the same passage, note, or disclosure
  source_context       "chairman_letter" | "ceo_letter" | "board_report" | "mda" |
                       "financial_statements" | "notes_to_accounts" | "risk_section" |
                       "governance_section"
  signal_type          one of the 19 types below
  impact               "high" | "medium" | "low"            (see IMPACT & SEVERITY RULES)
  severity             "critical" | "high" | "medium" | "low" | "informational"
  statement            MANDATORY FIELD: verbatim quote, exact words, no paraphrasing
                       
                       EXTRACTION RULE FOR STATEMENT:
                       ✓ Capture verbatim: "We will invest ₹500 Cr capex over next 3 years"
                       ✓ For numbers: capture the exact sentence: "We grew 12% YoY in FY25"
                       ✓ For policy notes: capture the key disclosure: "Depreciation is charged on straight-line basis"
                       ✓ For note details: capture the specific line from note: "Due <1 year: ₹100 Cr"
                       
                       SET TO NULL only when:
                       ✗ Signal is financial_figure and it's a pure number with no quote
                         (e.g., ₹5,000 Cr revenue extracted from P&L line — no narrative)
                       ✗ Signal is notes_to_accounts and it's a table entry with no supporting text
                         (e.g., "Debt maturity table row: Due 1-2yr, ₹150 Cr" — value from table only)
                       ✗ Signal has no source text because it's a derived/calculated field
                         (e.g., calculated ROCE from disclosed figures — not stated directly)
                       
                       Otherwise ALWAYS CAPTURE the statement.

COMMON FIELDS (fill the ones the type uses; otherwise null)
  category        the single sub-classification for this signal_type (allowed
                  values are listed under each type)
  metric          KPI abbr (see KPI ABBREVIATION RULES) where the type names a metric
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
                   start / end : ISO YYYY-MM-DD (apply DATE FORMATTING RULES) | null
                   type        : "annual" | "half_yearly" | "quarterly" | "snapshot" |
                                 "guidance" | "target" | "cumulative" | null

  measure ROLES (pick the role that names the number):
    reported          a reported/actual figure for a completed period (P&L, BS, CF lines)
    guided            a forward-looking guided figure
    baseline          the current/base figure a guidance is measured from
    prior             prior-period figure (for YoY comparisons within same signal)
    restated          a prior-period figure that was restated in current AR (earnings quality signal)
    growth_rate       a stated growth rate (store as decimal: 0.15 = 15%)
    absolute_target   a guided absolute target value
    quantum           an amount of capital being allocated or deployed
    scale             a stated opportunity size or market-size figure
    contingent        an unaccrued contingency / claim amount
    accrued           an amount already provisioned in P&L or notes
    milestone         a figure management states as already achieved
    revised           a revised guidance or estimate vs prior year guidance
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

These rules apply to every "metric" field and to any measure that references a metric.

1. Always check AVAILABLE KPIs first. Use the exact abbr from that list.
2. If the metric is not in the list → add it to new_kpis and use the abbr you assign there.
3. KPI abbrs are TIMELESS — never embed a period or fiscal year in the abbr.
   Use REV not REV_FY25; use EBITDA not EBITDA_FY25; use PAT not PAT_FY25.
   Time belongs in the measure's period.start / period.end.
4. Segment KPIs: prefix with SEG_<SEGMENT>_<ABBR> (e.g. SEG_RETAIL_REV, SEG_CEMENT_EBITDA).
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
Example: a single passage disclosing a ₹500 Cr acquisition and its integration timeline
emits two signals (m_and_a + ongoing) with the same source_statement_id and different signal_id.

For each type below: "category" values are the allowed sub-classifications;
listed measure roles are the numbers to emit; listed details keys are the only
type-specific extras.


### SIGNAL TYPE 1: financial_figure

Use for: EVERY numeric fact disclosed in the annual report — reported financials, notes
disclosures, MD&A numbers. This is the single extraction point for all quantified data.

ACCEPT:
  ✓ Revenue, EBITDA, EBIT, D&A, Finance Costs, PBT, PAT, PAT Margin, Other Income from P&L
  ✓ Current Tax Expense, Deferred Tax Asset/Liability from P&L and Balance Sheet
  ✓ Exceptional items, one-time gains/losses, asset write-downs, impairments from P&L/Notes
  ✓ Total Assets, Debt components, Equity, Cash, Working Capital items from Balance Sheet
  ✓ Goodwill, Intangible Assets from Balance Sheet and Goodwill Impairment Notes
  ✓ OCF, Capex, FCF, Dividends Paid, Tax Paid from Cash Flow Statement
  ✓ Segment Revenue, Segment EBIT/EBITDA, Segment Assets from Segment Reporting Note
  ✓ EPS (basic/diluted), DPS, Book Value per share from per-share note
  ✓ Financial ratios (ROE, ROCE, ROA, D/E, Interest Coverage, Current Ratio) if disclosed
  ✓ Debt schedule details: maturity profile (Due <1yr, 1-2yr, 2-3yr, >3yr), interest rates,
    security status (secured/unsecured), weighted avg cost of debt from Notes
  ✓ Contingent liability amounts: unaccrued and accrued amounts from Notes
  ✓ Related party transaction values: transaction amounts from Notes
  ✓ Tax reconciliation: statutory rate vs effective rate, tax adjustments from Notes
  ✓ Other Income breakdown: interest income, dividend income, gains on investments separately
    if disclosed in Notes
  ✓ Capacity metrics: installed capacity, utilisation %, capacity added from MD&A or Notes
  ✓ Volume metrics: units sold, tonnes produced, volumes shipped if stated in MD&A
  ✓ Cost structure: RM as % of revenue, employee cost %, power cost %, other cost % from MD&A
  ✓ Working capital days: DIO, DSO, DPO, CCC if explicitly disclosed in MD&A or Notes
  ✓ Restatements: if a prior-year figure was restated, capture both prior and restated values
  ✓ Growth rates: ONLY if explicitly stated (e.g. "Revenue grew 15%", "EBITDA up 200 bps",
    "margin expanded 150 bps"); do NOT calculate from reported figures
  ✓ Hedging positions: Forex hedges (notional foreign currency amount, hedge rate, maturity date),
    commodity hedges (contract volume, strike price, expiry), interest rate hedges (notional amount,
    fixed rate), derivatives fair value, mark-to-market gains/losses, hedge effectiveness ratios
    from derivatives/hedging notes
  ✓ Stock Options: number of options outstanding, weighted average exercise price, options
    granted/exercised/lapsed during year, vesting schedule details, number of shares reserved for
    future issuance, option expense, dilution impact if disclosed from stock-based compensation note

REJECT:
  ✗ Forward-looking numbers (use guidance or growth_forecast)
  ✗ Unquantified narrative commentary (use leadership_statement, strategic_claim, etc.)
  ✗ Calculated growth rates — only extract if explicitly stated in the document

MULTI-PERIOD RULE: Always extract all periods disclosed in financial statements.
For each line item, emit one measure per period (role=reported for current year,
role=prior for prior years). Do not consolidate multiple years into a single measure.

category: "income_statement" | "balance_sheet" | "cash_flow" | "segment_reporting" |
          "ratios" | "per_share" | "debt_schedule" | "tax" | "contingent_liability" |
          "related_party" | "goodwill" | "exceptional_items" | "other_income" |
          "capacity" | "volume" | "cost_structure" | "working_capital" | 
          "hedging_positions" | "stock_options" | "growth_rates" | "other"

  income_statement      — Revenue, EBITDA, EBIT, D&A, Finance Costs, PBT, PAT, PAT Margin
  balance_sheet         — Total Assets, Equity, Debt components, Cash, WC line items
  cash_flow             — OCF, Capex, FCF, Dividends Paid, Tax Paid, financing activities
  segment_reporting     — Any figure from segment note (revenue, EBIT, assets, by segment)
  ratios                — ROE, ROCE, ROA, D/E, Interest Coverage, Current, Quick, Turnover
  per_share             — EPS basic, EPS diluted, DPS, Book Value per share
  debt_schedule         — Maturity profile (due <1yr, 1-2yr, 2-3yr, >3yr), interest rates,
                          security status, weighted avg cost of debt from Notes
  tax                   — Current tax expense, deferred tax asset/liability, tax paid,
                          tax reconciliation (statutory vs effective), effective tax rate
  contingent_liability  — Unaccrued and accrued contingency amounts from Notes
  related_party         — Related party transaction amounts, amounts owed/owed to from Notes
  goodwill              — Goodwill created, intangible assets, impairment charges from Notes
  exceptional_items     — One-time gains/losses, asset write-downs, impairments from P&L/Notes
  other_income          — Interest income, dividend income, gains on investments component breakdown
  capacity              — Installed capacity, capacity utilised %, capacity added from MD&A/Notes
  volume                — Units sold, tonnes produced, volumes shipped if stated in MD&A
  cost_structure        — RM as % revenue, employee cost %, power cost %, other cost breakdowns
  working_capital       — DIO, DSO, DPO, CCC (cash conversion cycle) if explicitly disclosed
  hedging_positions     — Notional value of forex hedges, commodity hedges, interest rate hedges;
                          fair value of hedge positions; hedge effectiveness ratios from derivatives note
  stock_options         — Number of options outstanding, exercise price range, vesting schedule,
                          option expense, dilution impact on EPS from EPS note or stock-based comp note
  growth_rates          — ONLY if explicitly stated: "Revenue grew X%", "EBITDA up Y%", etc.;
                          do NOT calculate from disclosed figures

metric:   yes (KPI abbr from standard list above)
measures: role=reported (line item from statement or note, current period) ;
          role=prior (prior period figures for YoY comparison) ;
          role=restated (if prior year figure was restated, use this role for the corrected value)
          [EMIT ONE MEASURE PER PERIOD. IF 3 YEARS DISCLOSED, EMIT 3 MEASURES]
statement: null (financial statement line items have no narrative quote; omit)

details:
  financial_year    (string — "FY2025" or the period this figure applies to)
  is_consolidated   (boolean | null — true if consolidated statement/disclosure, false if standalone,
                    null if source cannot be determined)
  source_section    (string — precise location: "P&L line 5" | "Balance Sheet Schedule 10" |
                    "Cash Flow Statement" | "Notes to Accounts Note 6 (Debt Schedule)" |
                    "MD&A — Capex section" | "Segment Reporting Note" etc.)
  accounting_note   (string | null — if a specific accounting policy note applies, reference it)
  is_adjusted       (boolean — true if management adjusted/reclassified from statutory reported)
  restatement_note  (string | null — if prior year was restated, capture the reason/note reference;
                    used to track earnings quality red flags)
  component_breakdown (boolean — true if this is a breakdown of a parent category; e.g., Interest
                    Income is a breakdown of Other Income)
  currency          (string | null — if stated in currency other than INR; e.g., "USD" | "GBP")
  unit_detail       (string | null — for operational metrics, specify unit: "MW" | "tonnes" |
                    "units" | "stores" etc.)
  
  [hedging_positions category only:]
  hedge_type        (string — "forex" | "commodity" | "interest_rate" | "other")
  notional_value    (numeric | null — total notional exposure being hedged)
  notional_currency (string | null — for forex: currency being hedged "USD" | "EUR" | "GBP" etc.)
  hedge_rate        (numeric | null — for forex: locked-in exchange rate; for commodity: strike price)
  fair_value        (numeric | null — current fair value of hedge position)
  mark_to_market    (numeric | null — MTM gain/loss for the period)
  effectiveness     (numeric | null — hedge effectiveness ratio if disclosed, e.g., 0.95)
  maturity_date     (string | null — when hedges mature, e.g., "Q2 FY26", "6 months from year-end")
  
  [For commodity hedges specifically:]
  commodity_type    (string | null — "crude oil" | "aluminium" | "copper" | "wheat" etc.)
  contract_volume   (numeric | null — quantity being hedged, e.g., "1000 barrels")
  volume_unit       (string | null — unit of measurement: "barrels" | "tonnes" | "gallons" etc.)
  
  [stock_options category only:]
  option_type       (string — "ESOP" | "ESPS" | "other")
  options_outstanding (numeric | null — number of options outstanding at year-end)
  options_granted   (numeric | null — number of options granted during the year)
  options_exercised (numeric | null — number of options exercised during the year)
  options_lapsed    (numeric | null — number of options lapsed/cancelled during the year)
  weighted_avg_exercise_price (numeric | null — WAAP of options outstanding)
  exercise_price_range (string | null — range of exercise prices, e.g., "₹250–₹350")
  vesting_schedule  (string | null — vesting terms, e.g., "4-year cliff", "1-year cliff + 3-year ramp")
  shares_reserved   (numeric | null — number of shares reserved for future option exercise)
  option_expense    (numeric | null — stock-based compensation expense for the period)
  dilution_bps      (numeric | null — dilution impact in basis points, if explicitly stated)
  dilution_impact_on_eps (string | null — verbatim description if management quantifies EPS dilution)
  
  [growth_rates category only:]
  rate_type         (string — "revenue" | "ebitda" | "pat" | "other")
  is_explicit       (boolean — always true for growth_rates; signals this was stated, not calculated)
  source_quote      (string | null — verbatim management quote stating the growth rate)


### SIGNAL TYPE 2: notes_to_accounts

Use for: Details disclosed in notes that support and explain financial statement line items.
Extract EVERY note for EVERY line item in all 6 statements: consolidated P&L, BS, CF +
standalone P&L, BS, CF. Notes to accounts are the forensic layer of financial analysis.

Sources: All numbered notes following the financial statements (Note 1 through Note N).
Include: Accounting policies, debt schedules, segment reporting, contingent liabilities,
related party transactions, EPS calculation detail, tax reconciliation, goodwill impairment,
accounting changes, deferred tax detail, financial risk disclosures, lease schedules,
employee benefits, subsequent events, etc.

MANDATORY EXTRACTION: Every note that provides a breakdown, supporting detail, or context
for a line item in any of the 6 statements MUST be extracted as a notes_to_accounts signal.

category: "accounting_policy" | "debt_schedule" | "segment_detail" | "contingent_liability" |
          "related_party" | "eps_calculation" | "tax_reconciliation" | "goodwill_impairment" |
          "deferred_tax_detail" | "lease_schedule" | "employee_benefits" | "financial_risk" |
          "accounting_change" | "subsequent_events" | "other"

  accounting_policy       — Policy notes (Note 1, 1A, etc.): revenue recognition, depreciation method,
                            inventory valuation, investment classification, consolidation policy, etc.
  debt_schedule           — Debt detail (maturity profile, interest rates, security status, lender mix,
                            weighted avg cost of debt, covenant details)
  segment_detail          — Segment-wise revenue, expenses, assets, capital employed breakdown by segment
  contingent_liability    — Unaccrued and accrued liability amounts, dispute descriptions, forums, stages
  related_party           — RPT detail: transactions, amounts, approval status, arm's length certification
  eps_calculation         — Weighted average shares, dilutive securities, EPS calculation reconciliation
  tax_reconciliation      — Statutory vs effective rate, tax adjustments, deferred tax components by type
  goodwill_impairment     — Goodwill impairment testing: methodology, assumptions, fair value calculations,
                            impairment loss by CGU
  deferred_tax_detail     — Deferred tax asset/liability breakdown by component (timing differences, losses)
  lease_schedule          — Operating/finance lease detail: lease term, interest rates, future payments,
                            ROU asset rollforward
  employee_benefits       — Gratuity, pension, stock option detail: actuarial assumptions, ABO, plan assets,
                            expense reconciliation
  financial_risk          — Interest rate risk, currency risk, credit risk, liquidity risk detail with
                            sensitivity analysis if disclosed
  accounting_change       — Accounting policy change explanation, impact on comparability, restatements
  subsequent_events       — Events after balance sheet date that affect financial position
  other                   — Any other note not in above categories

metric:   yes (KPI abbr for the note detail metric; register in new_kpis if not standard)
measures: role=reported (current year figure from note) ;
          role=prior (prior year figure from note, if disclosed) ;
          role=restated (if prior year was restated, capture corrected value)
          [EMIT ONE MEASURE PER PERIOD. IF NOTE DISCLOSES 3+ YEARS, EMIT 3+ MEASURES]

horizon:   yes if note contains forward-looking detail (debt maturity schedule, future lease 
           payments, contingent outcome); null if note refers only to completed periods
topic:    short label for the specific note detail (e.g. "maturity_profile", "segment_revenue_breakdown",
          "deferred_tax_asset_losses", "goodwill_cgu_impairment")

statement: verbatim material narrative IF note contains substantive explanatory text 
           (e.g., contingent liability dispute description, goodwill impairment rationale);
           null ONLY if note is a pure table/schedule with no narrative content

segment_name: if this note detail is segment-specific, set to segment name
is_segment_level: true if this note detail is for a specific segment, false/null if consolidated

SOURCE_CONTEXT ROUTING for notes_to_accounts:
  All notes_to_accounts signals have source_context: notes_to_accounts

details:
  financial_year      (string — "FY2025" or period this note applies to)
  is_consolidated     (boolean | null — true if this note detail is from consolidated note,
                      false if from standalone note, null if cannot determine)
  note_reference      (string — exact note number and title, e.g., "Note 6: Borrowings" |
                      "Note 47: Segment Reporting" | "Note 15: Deferred Tax")
  parent_line_item    (string | null — which BS/P&L/CF line this note supports; e.g.,
                      "Total Debt" | "Revenue from Operations" | "Other Comprehensive Income";
                      null if note is structural/policy and not tied to single line)
  statement_type      (string — which statement this note supports: "balance_sheet" | "income_statement" |
                      "cash_flow" | "equity_statement" | null if policy note)
  note_section        (string | null — if note has subsections (A, B, C, etc.), specify;
                      e.g., "Note 6A: Secured Borrowings")
  component_of        (string | null — if this note detail is a component of a parent note;
                      e.g., "Component of Note 47: Segment Reporting")
  accounting_note     (string | null — if this note detail is qualified or has a footnote, reference it)
  is_adjusted         (boolean — true if note figure has been adjusted by management vs. statutory)
  restatement_note    (string | null — if note figure was restated, capture reason/reference)

LINKING RULE: notes_to_accounts signals link to financial_figure signals via source_statement_id.
Example: A financial_figure signal for "Total Debt ₹500 Cr" and 3 notes_to_accounts signals
for "Debt maturity <1yr", "Debt maturity 1-2yr", "Debt maturity 2-3yr" all share the same
source_statement_id, showing they came from the same disclosure source.



### SIGNAL TYPE 3: guidance

Use for: Forward-looking TARGETS or COMMITMENTS explicitly stated in the annual
report that have a future delivery not yet realised at time of publication.

TENSE CHECK — ACCEPT:
  ✓ Future: "will", "expect to", "targeting", "planning to", "aiming for", "by FY28"

TENSE CHECK — REJECT:
  ✗ Historical performance (use financial_figure or milestone)
  ✗ Current in-progress initiatives (use ongoing)
  ✗ Implied or inferred guidance — extract ONLY explicitly stated guidance
  ✗ Third-party forecasts or analyst projections

category: "timebound_guidance" | "open_ended_guidance"
  timebound_guidance   — has stated deadline or target year (e.g. "we will reach ₹5,000 Cr revenue by FY27")
  open_ended_guidance  — no stated deadline (e.g. "we expect to expand margins over time")

metric:   yes (KPI abbr)
topic:    short label for the guidance topic (e.g. "revenue_fy27_target", "capex_2yr_plan", 
          "debt_reduction_commitment")
statement: verbatim guidance statement if one exists; null only if guidance is purely metric
horizon:   yes
is_consolidated: boolean | null — true if guidance applies to consolidated entity, false if subsidiary/segment-specific,
                null if cannot determine

measures: role=guided (value, value_raw, unit, period{type="guidance"}) ;
          role=baseline (value, value_raw — the current base if stated alongside guidance)

period:   [CRITICAL — use consistent nomenclature with TYPE 4 growth_forecast]
          period.type="target" (the target year, e.g., FY27 for "₹5000 Cr revenue by FY27")
          period.type="base" (baseline period IF explicitly stated, e.g., "from ₹4000 Cr base")
          Set period.base=null if baseline not stated in guidance

details:
  condition  (string | null — verbatim condition ONLY if explicitly stated with words 
             like 'subject to', 'if', 'provided that', 'contingent upon'; null otherwise)



### SIGNAL TYPE 4: growth_forecast

Use for: Specific growth guidance that feeds the earnings model. Extract ONLY explicitly
stated growth rates or absolute targets that allow growth calculation. Do NOT infer or
calculate growth rates from non-explicit statements.

ACCEPT — extract these:
  ✓ Quantified growth rates: "15% CAGR over 3 years", "EBITDA up 200 bps"
  ✓ Absolute targets with baseline context: "Revenue ₹5000 Cr by FY27 from ₹4000 Cr base"
  ✓ Qualitative with explicit baseline: "will grow from X to Y"
  ✓ Margin/efficiency targets: "will expand margins by 150 bps", "operating leverage to improve ROCE"

REJECT — do NOT extract:
  ✗ Vague directional language: "expect strong growth", "aim for faster growth", "organic growth ahead"
  ✗ Calculated growth rates: do NOT calculate 15% CAGR from ₹4000 Cr to ₹5000 Cr
  ✗ Analyst projections or third-party forecasts
  ✗ Industry growth rates (use industry_signal for these)

If a statement qualifies as both guidance and growth_forecast, emit BOTH signals
with the same source_statement_id.

metric:    yes — KPI abbr for the metric being forecast (REV, EBITDA, PAT, EPS, CAPEX, etc.)
horizon:   yes
statement: verbatim growth forecast quote if one exists; null otherwise
is_consolidated: boolean | null — true if forecast applies to consolidated entity, false if subsidiary/segment-specific,
                null if cannot determine

measures:  role=growth_rate (value as decimal, 0.15 = 15%; value_raw; unit="%") ;
           role=absolute_target (value; value_raw; unit) ;
           [EMIT BOTH ROLES WHEN BOTH ARE DETERMINABLE FROM GUIDANCE. Never choose one.]

period:    [CONSISTENT with TYPE 3 guidance — use same nomenclature for all forward-looking signals]
           period.type="base" (baseline period for growth measurement, typically prior FY actual; e.g., FY26)
           period.type="target" (target year; e.g., FY29)
           set period.base=null if baseline not stated in guidance

details:
  confidence_level ("committed" | "aspirational" | "directional")
    committed    — stated in formal guidance section OR same exact target repeated in 2+ sections
    aspirational — stated once as a management "target" or "expect"
    directional  — qualitative direction only: "we aim to", "we plan to grow", "expect to expand"
  
  baseline_period (string | null — the period from which growth is measured, e.g., "FY26 actual")


### SIGNAL TYPE 5: capital_allocation

Use for: Statements on HOW capital is being or will be deployed — capex plans,
dividend policy, debt repayment commitments, buyback announcements, working capital
investment, or treasury strategy. Extract from MD&A, Board Report, cash flow
commentary, and Chairman/CEO letters.

DISTINCTION: capital_allocation = HOW funds will be DEPLOYED (action/commitment);
            guidance (TYPE 3) = WHAT will be ACHIEVED (target/outcome)
            These are different lenses and may overlap. Emit both if both apply.

category: "capex" | "dividend" | "debt_reduction" | "buyback" | "working_capital" |
          "acquisition_funding" | "r_and_d" | "other"
  capex              — expansion, maintenance, technology infrastructure, new greenfield
  dividend           — declared/proposed dividends, payout ratio targets, policy changes
  debt_reduction     — repayment commitments, leverage targets, refinancing plans
  buyback            — share repurchase programs
  working_capital    — receivables, inventory, or payables strategy changes
  acquisition_funding— capital reserved or raised for M&A
  r_and_d            — product / technology investment budget

metric:    yes (KPI abbr — e.g. CAPEX, DPS, NET_DEBT, NET_DE_RATIO)
statement: verbatim capital allocation statement if one exists; null otherwise
horizon:   yes (all capital_allocation is forward-looking)
is_consolidated: boolean | null — true if allocation applies to consolidated entity, false if subsidiary/division-specific,
                null if cannot determine
timeline:  yes (deployment period if stated; null if not)

measures:  role=quantum (capital amount, value, value_raw, unit) ;
           role=guided (if forward-looking target stated) ;
           role=baseline (current level if stated alongside future target)

direction: "increase" | "decrease" | "maintain" | "redeploy" | null

details:
  source_of_funds   (string | null — "internal accruals" | "fresh debt" | "equity" | other;
                     ALWAYS TRY TO EXTRACT from MD&A/Board Report; null only if not stated)
  capex_purpose     (string | null — verbatim purpose if stated; for capex category only)
  return_target     (string | null — stated IRR, payback, or ROCE target if disclosed;
                     applies to capex and acquisition_funding categories)


### SIGNAL TYPE 6: risk_factor

Use for: Extract every disclosed risk identified in sections like the Risk Management section, 
MD&A risk commentary, Board Report, or other areas where risks are explicitly stated. Do NOT 
filter or interpret severity — capture all identified risks.

REJECT:
  ✗ Legal claims and contingent liabilities (use contingent_liability)
  ✗ Generic industry boilerplate with no company-specific context
  ✗ Accounting policy risks (use disclosure_quality)

category: "market_risk" | "operational_risk" | "regulatory_risk" | "financial_risk" |
          "strategic_risk" | "esg_risk" | "technology_risk" | "concentration_risk" |
          "geopolitical_risk" | "other"
  market_risk        — commodity prices, interest rates, exchange rates
  operational_risk   — supply chain, manufacturing, IT systems, key person
  regulatory_risk    — regulatory approvals, policy changes, compliance
  financial_risk     — liquidity, refinancing, credit risk
  strategic_risk     — competitive disruption, business model risk
  esg_risk           — environmental, social, governance exposures
  technology_risk    — cyber risk, technology obsolescence
  concentration_risk — customer, supplier, or geographic concentration

direction: "increasing" | "decreasing" | "stable" | null
           ONLY if EXPLICITLY STATED in the document (e.g., "increasing geopolitical risk",
           "declining commodity price risk"). Set to null if direction not stated.

statement: verbatim risk disclosure if one exists; null otherwise
is_consolidated: boolean | null — true if risk applies to consolidated entity, false if unit/subsidiary-specific,
                null if cannot determine

measures:  [if risk has a quantified exposure EXPLICITLY STATED in the report — 
           role=quantum, value, unit=Cr or %]
           Do NOT estimate or calculate impact from other numbers.

details:
  mitigation_stated    (boolean — true ONLY if mitigation plan explicitly disclosed with
                       keywords like "mitigation", "hedging", "control", "safeguard" AND
                       describes specific action; false if vague or no mitigation mentioned)
  mitigation_summary   (string | null — verbatim mitigation if stated)
  risk_owner           (string | null — committee or function explicitly named as responsible;
                       null if not disclosed)


### SIGNAL TYPE 7: contingent_liability

Use for: Unaccrued legal claims, tax disputes, regulatory penalties, financial guarantees,
and other contingent obligations disclosed in Notes to Accounts.

ALWAYS extract regardless of amount. Small contingencies accumulate and signal
litigation culture or regulatory relationship.

category: "tax_dispute" | "legal_claim" | "regulatory_penalty" | "guarantee" |
          "environmental_claim" | "labour_dispute" | "other"

statement: verbatim contingent liability disclosure if one exists; null otherwise
is_consolidated: boolean | null — true if liability from consolidated notes, false if from standalone notes,
                null if cannot determine. CRITICAL: contingent liabilities may be disclosed in BOTH consolidated
                AND standalone notes with different amounts — emit separate signals for each.

measures: role=contingent (total unaccrued amount, value, value_raw, unit=Cr) ;
          role=accrued (amount provisioned if separately stated in notes)

details:
  dispute_description  (string — verbatim from notes; exact language required)
  forum                (string | null — court / tribunal / authority if stated)
  period_of_dispute    (string | null — the years under dispute if explicitly stated;
                       null if not specified; do NOT infer from context)
  outcome_expected_date (string | null — expected resolution/outcome date if explicitly stated;
                       e.g., "FY26", "next financial year", "Q2 FY26"; null if not disclosed)
  company_position     (string | null — ONLY IF company explicitly states outcome expectation
                       with language like "counsel opines claim will fail", "likely to be resolved favorably",
                       "management believes will succeed"; null if no explicit position disclosed)
  related_party        (boolean — true if the dispute involves a related party;
                       if true, emit BOTH contingent_liability AND governance_signal
                       with same source_statement_id)


### SIGNAL TYPE 8: governance_signal

Use for: Signals from Corporate Governance section, Audit Committee Report, Board Report,
or Notes to Accounts that reflect governance quality — director changes, audit qualifications,
related party disclosures, promoter pledging, insider transactions, or committee observations.

SCOPE: Governance signals apply to the consolidated parent company. Subsidiary-specific governance 
(e.g., subsidiary board changes, subsidiary auditor changes) are disclosed as related_party signals 
or governance_signal with subsidiary context in details.party_name.

PRIORITY SIGNALS — always extract if present, regardless of size:
  ✓ Auditor qualification or emphasis of matter (from auditor's report)
  ✓ Promoter pledge creation or increase (any amount)
  ✓ Material related party transactions (any disclosed)
  ✓ Board composition change (appointment/departure of any director)
  ✓ Audit committee observations: ONLY if AC Report contains language like "flagged concern",
    "issue identified", "weakness noted", OR explicit recommendation for management action
  ✓ Key managerial personnel (KMP) changes: statutory KMP (MD/CEO, CFO, Company Secretary) +
    any C-suite departures/appointments (COO, CTO, etc.)
  ✓ Dividend waiver by promoter group

category: "board_composition" | "audit_qualification" | "related_party" |
          "promoter_pledging" | "insider_transaction" | "committee_observation" |
          "kmp_change" | "dividend_waiver" | "other"

statement: verbatim governance disclosure if one exists; null otherwise
measures:  role=reported (quantified disclosures — pledge amount, RPT value, director count)

details:
  party_name      (string | null — name of related party, director, or KMP if stated)
  nature_of_txn   (string | null — verbatim description of transaction or event)
  approval_status (string | null — "approved by audit committee" / "board approval" etc;
                   null if not disclosed; do NOT infer)
  auditor_name    (string | null — auditing firm name if signal is from auditor report)
  is_arms_length  (boolean | null — true ONLY if RPT explicitly stated as at arms' length;
                   null if not disclosed)


### SIGNAL TYPE 9: strategic_claim

Use for: Management assertions of competitive advantages, moat characteristics, market
positioning, or business quality. Extract them exactly as stated; do NOT validate unverified claims.

SCOPE: Strategic claims typically apply to the consolidated entity ("we are India's largest player",
"our scale advantage"). Subsidiary-specific claims should be captured with subsidiary context in statement.

ACCEPT:
  ✓ Competitive positioning claims: "largest player in segment", "25% market share", "#1 in innovation"
  ✓ Moat characteristics: "proprietary technology", "brand equity", "scale advantages"
  ✓ Differentiation: "lowest-cost producer", "fastest time-to-market", "best-in-class distribution"

REJECT:
  ✗ Aspirational/values statements with NO SPECIFICITY: "committed to quality", "customer-centric",
    "focused on excellence" (identify by keywords: committed, focused, dedicated, passionate + no metrics)
  ✗ Statements backed by quantified financial data (already captured in financial_figure or milestone)
  ✗ Forward-looking positioning (use guidance)
  ✗ Industry structure commentary (use industry_signal)
  ✗ Boilerplate language: "we are committed to quality", "customer-centric approach"

KEYWORD FILTER for boilerplate rejection:
  If claim contains "committed to", "focused on", "dedicated to", "passionate about", "striving for"
  AND no specific metric/evidence follows → likely boilerplate, extract with caution or skip

category: "competitive_moat" | "brand_strength" | "technology_leadership" |
          "distribution_advantage" | "cost_leadership" | "regulatory_moat" |
          "customer_captivity" | "scale_advantage" | "other"

metric:   null (strategic claims are narrative assertions, not quantified metrics)
statement: verbatim strategic claim; null only if no narrative (unlikely)

details:
  evidence_cited  (string | null — any evidence management provides for the claim;
                   extract ONLY if management explicitly provides quantified support;
                   null if assertion only or evidence is vague)


### SIGNAL TYPE 10: m_and_a

Use for: Disclosed acquisitions, divestments, mergers, joint ventures, or material asset
deals in the current or prior fiscal year.

SCOPE: M&A transactions apply to the consolidated parent company (affect consolidated balance sheet).
Subsidiary-level M&A transactions should be captured as m_and_a signals sourced from consolidated notes.

If no M&A activity is disclosed, do NOT emit this signal type.

category: "acquisition" | "divestment" | "merger" | "joint_venture" | "asset_purchase" |
          "asset_sale" | "stake_acquisition" | "other"

measures: role=quantum (deal value/consideration if stated, unit=Cr)
details:
  target_name          (string | null — name of acquired/divested entity or asset IF explicitly stated;
                        null if name not disclosed in annual report)
  deal_status          (string — "completed" | "pending_approval" | "announced" | "integrated"
                        IF status explicitly stated; else null)
  strategic_rationale  (string | null — verbatim management rationale if stated)
  deal_structure       (string | null — "cash" | "stock" | "earn-out" | "mixed" if stated)
  goodwill_created     (string | null — ₹Cr figure from goodwill note if disclosed)
  synergy_target       (string | null — stated synergy value or description if disclosed)
  integration_status   (string | null — progress commentary from MD&A if stated)
  revenue_contribution (string | null — post-acquisition revenue disclosed if stated)


### SIGNAL TYPE 11: kpi

Use for: Extract ONLY metrics explicitly labeled or defined as "KPI", "key metric", 
"key performance indicator" in the document. Do NOT infer KPI status based on importance.

SCOPE: Segment KPIs are typically from consolidated segment reporting (most companies report segments only
in consolidated financials). If a KPI is for a named subsidiary or standalone segment, capture context
in segment_name and is_segment_level fields.

Include operational, business-specific, and sector-specific KPIs that are NOT 
direct P&L / Balance Sheet / Cash Flow line items.

Examples: store count, capacity utilisation, fleet utilisation, occupancy rate,
customer acquisition cost, NPS score, volume sold, market share %, order book, SMA0/1/2/3, 
CASA, branches, credit to deposit ratio, average contract value.

KPI SCOPE RULE: Do NOT extract standard financial ratios here (use financial_figure
with category=ratios for ROE, ROCE, D/E, etc.).

category: "operating_efficiency" | "capacity" | "customer" | "distribution" |
          "quality" | "esg" | "volume" | "market_share" | "order_book" | "other"

metric:       yes (KPI abbr — register in new_kpis if not in AVAILABLE KPIs)
is_segment_level: true if segment/subsidiary KPI
segment_name: segment name if is_segment_level is true
measures:     role=reported (current year, value, value_raw, unit, period) ;
              role=prior (prior year if disclosed)
details:
  kpi_definition  (string | null — how management defines this KPI, if explicitly stated)
  target          (string | null — stated target or benchmark if disclosed alongside KPI)




### SIGNAL TYPE 12: milestone

Use for: Completed achievements explicitly stated in the annual report — results, records,
and accomplishments for the period under review. MUST be quantified or explicitly evaluative.

ACCEPT — only with QUANTIFICATION or EXPLICIT EVALUATION:
  ✓ Quantified: "We grew 12%", "We delivered ₹X Cr", "We launched 50 stores"
  ✓ Explicitly evaluative: "We achieved record margins", "We delivered best-ever quarter"
  ✗ Reject: "We have improved" (unquantified)
  ✗ Reject: "We continue to strengthen" (vague, not completed)

REJECT — these do NOT belong here:
  ✗ Unquantified statements matching past tense only
  ✗ Forward-looking statements (use guidance or growth_forecast)
  ✗ Current in-progress initiatives (use ongoing)
  ✗ Raw financial line items from financial statements (use financial_figure)

category: "financial_performance" | "operational_achievement" | "strategic_progress" |
          "comparative_milestone" | "governance_milestone" | "other"
  financial_performance   — revenue, margins, PAT, ROE achievement in narrative form
  operational_achievement — capacity added, market share gained, products launched
  strategic_progress      — stated milestone reached (plant commissioned, JV formed)
  comparative_milestone   — milestone relative to peers, industry, or historical performance
  governance_milestone    — governance improvement achieved (credit rating upgrade, auditor change)

metric:   yes (KPI abbr)
is_consolidated: boolean | null — true if milestone for consolidated entity, false if subsidiary/unit-specific,
                null if cannot determine

measures: role=milestone (the achieved figure, value, value_raw, unit, period) ;
          role=prior (comparison figure if stated alongside)
details:
  achievement_context  (string | null — brief verbatim context for why management flags this)


### SIGNAL TYPE 13: ongoing

Use for: Extract ONLY statements using present continuous tense: "we are", "we continue",
"currently rolling out", "in the process of". Do NOT infer "in progress" from other signals.

REJECT:
  ✗ Boilerplate: "We remain committed to excellence", "We continue to focus on value"
  ✗ Completed: "We have launched" (use milestone)
  ✗ Future planned: "We will launch" (use guidance)
  ✗ Vague statements without explicit "we are" or "currently" phrasing

TENSE RULE: Only extract statements with explicit present continuous phrasing. 
            If the statement says "will" → guidance. If "have/has" → milestone.

category: "timebound" | "open_ended"
  timebound  — initiative has a stated end target or deadline (extract ONLY if explicitly stated in text)
  open_ended — no stated deadline

CRITICAL: category.timebound is determined by completion_target field:
  - If completion_target is null → category="open_ended"
  - If completion_target is stated → category="timebound"
  Do NOT infer timebound status; let the presence/absence of completion_target drive the category.

metric:   yes (KPI abbr for the resource/metric involved)
topic:    yes (short initiative label — e.g. "plant_expansion", "digital_transformation", "debt_reduction")
is_consolidated: boolean | null — true if initiative applies to consolidated entity, false if subsidiary/division-specific,
                null if cannot determine

measures: role=quantum (investment amount if stated, value, value_raw, unit=Cr) ;
          role=scale (total scope of initiative if stated, e.g. total capacity at completion)

details:
  initiative_name    (string | null — management name for the initiative if stated)
  completion_target  (string | null — stated completion date or milestone if explicitly stated
                     in text; e.g., "Q2 FY26", "by end of 2026", "plant commissioning target"; 
                     null only if no target stated)
  current_progress   (string | null — verbatim progress update from annual report)


### SIGNAL TYPE 14: industry_signal

Use for: Commentary on everything about industry structure and market — nothing company-specific.
Industry demand drivers, players in the industry, regulatory environment, or macroeconomic context.
Captures management's view of the external environment.

REJECT:
  ✗ Company-specific forward-looking claims (use guidance or growth_forecast)
  ✗ Third-party analyst projections without management commentary endorsing them

category: "demand_environment" | "supply_dynamics" | "competitive_intensity" |
          "regulatory_change" | "macro_tailwind" | "macro_headwind" |
          "pricing_environment" | "technology_disruption" | "export_import" | "other"

horizon:   yes
measures:  role=scale (if market size stated, value, value_raw, unit) ;
           role=growth_rate (if industry growth rate stated)

period:    period_range (string | null — if forecast or outlook covers a specific period range,
           capture it; e.g., "FY25-FY30", "next 5 years", "2025-2029"; null if no range stated)

details:
  market_name   (string | null — which market or segment this applies to)
  data_source   (string | null — source cited by management, e.g. "CRISIL", "IBEF", "internal")
  drivers       (string[] — up to 5 key phrases describing the driver, max 8 words each)


### SIGNAL TYPE 15: disclosure_quality

Use for: Auditor qualifications, emphasis of matter paragraphs, and auditor observations 
that relate to disclosure adequacy, reporting quality, or accounting uncertainty. Extract 
exactly what the auditor flagged.

ACCEPT:
  ✓ Auditor qualification on disclosure of contingent liabilities
  ✓ Emphasis of matter: going concern uncertainty
  ✓ Emphasis of matter: accounting estimate uncertainty (impairment, provisions, fair value)
  ✓ Auditor emphasis of matter on revenue recognition or segment reporting quality
  ✓ Qualified opinion on internal controls or compliance disclosures

category: "auditor_qualification" | "going_concern" | "accounting_estimate_uncertainty" |
          "revenue_recognition" | "internal_controls" | "segment_reporting" |
          "contingent_liability_disclosure" | "other"

is_consolidated: boolean | null — true if qualification/emphasis applies to consolidated statements,
                false if applies to standalone statements, null if applies to both or cannot determine

direction: "negative" | "neutral"
details:
  auditor_statement  (string — verbatim auditor language from qualification or emphasis of matter)
  subject_matter     (string — what the auditor is flagging: revenue, impairment, contingency, etc.)




### SIGNAL TYPE 16: guidance_revision

Use for: Annual report disclosures where current-year actual performance is compared 
against a prior guidance or plan.

REQUIRES: PRIOR_AR_FY_END must be set in the context block. Do not emit this signal type
if prior year guidance cannot be confirmed from the statement being extracted.

metric:   yes (KPI abbr — the metric tracked)
is_consolidated: boolean | null — true if revision tracks consolidated metrics, false if subsidiary/segment-specific,
                null if cannot determine

measures: role=guided (prior-year guidance, value, value_raw, unit, period.type="guidance") ;
          role=actual (this year's realised outcome, value, value_raw, unit, period.type="annual") ;
          role=baseline (if guidance was set from a base period, include)

details:
  prior_guidance_source  (string — where guidance was found: "FY[YYYY] annual report — [section]")
  variance_description   (string — verbatim or calculated description of outcome vs guidance)
  management_explanation (string | null — any explanation offered in current AR; null if none)
  prior_guidance_quoted  (boolean — true if prior guidance is verbatim from prior AR; false if inferred)


### SIGNAL TYPE 17: corporate_structure

Use for: Organizational composition — subsidiaries, associates, joint ventures with ownership %, 
control, and management structure. Extract ONLY explicitly disclosed corporate architecture.

ACCEPT:
  ✓ "Company holds 100% stake in Subsidiary ABC Limited"
  ✓ "Associate XYZ Holdings (28% ownership, significant influence)"
  ✓ "Joint venture with Partner Co. (50:50 partnership, governed by JV agreement)"
  ✓ "Wholly-owned subsidiary incorporated in Singapore"

REJECT:
  ✗ Inferred ownership structures not stated
  ✗ Historical corporate restructuring narrative (use m_and_a instead)

category: "subsidiary" | "associate" | "joint_venture" | "holding_structure" | "other"

metric:   yes (subsidiary/JV name as KPI if tracking ownership %)
measures: role=reported (current year ownership %, control status, management representation)
statement: verbatim disclosure of corporate structure detail

details:
  entity_name         (string — legal name of subsidiary, associate, or JV)
  ownership_pct       (number | null — percentage stake if disclosed)
  control_status      (string — "controlled" | "significantly influenced" | "passive investment" | null)
  management_rights   (string | null — board seats, voting rights, veto powers if disclosed)
  incorporation_jurisdiction (string | null — country/state of incorporation)
  business_description (string | null — line of business or operating jurisdiction if stated)
  consolidation_status (string | null — "consolidated" | "equity method" | "fair value")


### SIGNAL TYPE 18: business_model

Use for: Revenue composition, customer base concentration, distribution channels, and pricing 
mechanisms. Captures how the company generates revenue and reaches customers.

ACCEPT:
  ✓ "Revenue composition: 60% domestic, 40% exports; 55% B2B, 45% B2C"
  ✓ "Top 10 customers represent 35% of revenue"
  ✓ "Distribution through 500 retail outlets and 3 e-commerce platforms"
  ✓ "Pricing mechanism: Cost-plus 20-25% markup in domestic market"
  ✓ "Customer base: 1,200 corporate clients, 50,000 retail customers"

REJECT:
  ✗ Mission/vision statements about target markets
  ✗ Narrative without quantification ("we serve diverse markets")
  ✗ Forward-looking business model changes (use guidance instead)

category: "revenue_stream" | "customer_concentration" | "distribution_channel" | "pricing_model" | 
          "geographic_mix" | "customer_segmentation" | "other"

metric:   yes (e.g., "TOP_10_CUSTOMER_PCT", "DOMESTIC_REV_PCT", "RETAIL_OUTLETS_COUNT")
is_consolidated: boolean | null — true if business model applies to consolidated entity, false if segment/subsidiary-specific,
                null if cannot determine

measures: role=reported (current year percentages, counts, or descriptors)
statement: verbatim disclosure of business model element

details:
  component_name      (string — specific element: "Top 10 customers", "Domestic revenue", "Direct sales")
  quantification      (string | null — percentage, count, description)
  period_coverage     (string | null — "FY2025" or date period if time-specific)
  change_vs_prior     (string | null — any year-on-year change mentioned)
  source_disclosure   (string — "Business Overview" | "MD&A" | "Chairman's Letter" | "Board Report")


### SIGNAL TYPE 19: supply_chain

Use for: Sourcing model, supplier concentration, geographic dependence, import-export exposure, 
and supply chain risks or opportunities disclosed.

ACCEPT:
  ✓ "Raw material sourced from 120 suppliers; top 3 suppliers represent 25% of purchases"
  ✓ "80% of components imported from Southeast Asia"
  ✓ "Single-source supplier for critical component X"
  ✓ "Backward integration: 60% of raw material sourced internally"
  ✓ "Export exposure: 45% of revenue subject to port/logistics costs"

REJECT:
  ✗ General supply chain risk statements without detail (use risk_factor instead)
  ✗ Future supply chain plans (use guidance or ongoing instead)

category: "supplier_concentration" | "sourcing_geography" | "import_export" | "backward_integration" | 
          "logistics" | "single_source_dependency" | "other"

metric:   yes (e.g., "TOP_3_SUPPLIER_PCT", "IMPORT_PCT", "INTERNAL_SOURCING_PCT")
is_consolidated: boolean | null — true if supply chain applies to consolidated entity, false if subsidiary-specific,
                null if cannot determine

measures: role=reported (current year percentages, counts, or supplier counts)
statement: verbatim disclosure of supply chain composition

details:
  supply_chain_component (string — "raw materials" | "components" | "finished goods" | "logistics" | "other")
  concentration_metric    (string | null — "top 3 suppliers", "top customer", etc.)
  percentage_or_count     (number | null — percentage of purchases/costs or supplier count)
  geographic_detail       (string | null — country or region of sourcing/export)
  dependency_type         (string | null — "single-source" | "high concentration" | "geographic dependence" | null;
                           factual exposure only, NOT risk assessment)
  mitigation_stated       (boolean — true if mitigation strategy disclosed with keywords:
                           "mitigation", "risk management", "contingency plan", "diversification")

----------------------

## IMPACT & SEVERITY RULES

Assign to every signal.

impact — materiality for investment decision-making:
  "high"   — thesis-changing: governance red flag, structural industry shift, large contingency,
             major guidance delivery miss, earnings quality concern materially affecting reported profits
  "medium" — noteworthy, affects monitoring or valuation, but not immediately thesis-changing
  "low"    — confirmatory, routine, minor, or informational

severity — risk level:
  "critical"      — immediate action required: auditor qualification, covenant breach,
                    large promoter pledge, fraud signal, material restatement, regulatory enforcement
  "high"          — serious risk requiring active monitoring (contingency >5% of equity, promoter pledge)
  "medium"        — moderate concern (competitive pressure, policy risk, working capital deterioration)
  "low"           — minor concern
  "informational" — neutral or positive signal; default for all positive signals

SEVERITY ESCALATION RULES:
  - Any governance_signal with audit_qualification or promoter_pledging → minimum "critical"
  - Any contingent_liability > ₹100 Cr AND adverse outcome possible → minimum "high"
  - Any disclosure_quality signal with l2_flag=true → minimum "high"
  - Any guidance_revision with category=delivery_missed on a revenue or PAT metric → minimum "high"

----------------------

## EXTRACTION RULES

Apply these extraction rules to every run. They form the contract between L1 and L2.

1. Statement extraction is MANDATORY. For every signal:
   
   RULE: Capture the verbatim quote from the source if one exists. Never paraphrase.
   
   Set to NULL only when the information is purely numeric or tabular with no accompanying narrative text.
   
   When in doubt: CAPTURE THE STATEMENT.

2. Verbatim is non-negotiable. The "statement" field must be the exact words from the source.
   Never paraphrase, summarize, or reword.

2a. source_context is determined by WHERE the data was found. Extract or set to null:
   
   RULE: Identify the source location and set source_context accordingly:
   
     ✓ Found in P&L statement → source_context: financial_statements
     ✓ Found in Balance Sheet → source_context: financial_statements
     ✓ Found in Cash Flow statement → source_context: financial_statements
     ✓ Found in Notes to Accounts (any note 1-N) → source_context: notes_to_accounts
     ✓ Found in MD&A section → source_context: mda
   
   DO NOT FORCE-FIT: Extract with the source_context matching where you actually found the number.
   Follow the actual location.
   
   Set to NULL if you can't identify the source location in the annual report.
   
   NEVER assume or infer location. Only set source_context based on explicit discovery in the AR.

4. notes_to_accounts is MANDATORY. Extract every note for every line item in all 6 statements:
   - Consolidated P&L, BS, CF
   - Standalone P&L, BS, CF (if disclosed separately)
   
   Include all 14 categories and more:
   - Accounting policies (Note 1, etc.)
   - Debt schedules with maturity, rates, security
   - Segment detail with revenue, expenses, assets by segment
   - Contingent liabilities with amounts, descriptions, forums
   - Related party transactions with amounts, nature, approval
   - EPS calculation detail with share count, dilution
   - Tax reconciliation with statutory vs effective rate
   - Goodwill impairment with methodology, assumptions, CGU detail
   - Deferred tax components by type
   - Lease schedules with terms, rates, payments
   - Employee benefits with actuarial detail
   - Financial risk disclosures with sensitivity
   - Accounting changes with impact and restatements
   - Subsequent events
   
   Each note detail emits separate notes_to_accounts signal(s), linked to financial_figure
   via source_statement_id.

5. Consolidated vs Standalone dual extraction for notes. WHEN a note is disclosed for BOTH
   consolidated AND standalone (e.g., Debt Schedule for both), EXTRACT BOTH separately:
   - Same note detail, two signals: one with is_consolidated=true, one with is_consolidated=false
   - Link via source_statement_id to show they came from same note disclosure
   This surfaces any differences between consolidated and standalone note detail.

6. Source integrity. If information spans multiple notes, extract each separately with the
   correct note_reference. Do NOT merge signals from different notes into one signal.

7. No fabrication. If a note detail is not disclosed, do NOT estimate or infer.

8. Segment-level data. When a note breaks down a line item by segment (e.g., Segment 
   Revenue, Segment EBIT, Segment Assets), emit ONE signal per segment.
   
   Example: Segment Reporting Note shows:
     - Segment A: Revenue ₹200 Cr, EBIT ₹40 Cr
     - Segment B: Revenue ₹150 Cr, EBIT ₹25 Cr
   
   Extract as TWO separate notes_to_accounts signals:
     Signal 1: segment_name: "Segment A", Segment Revenue ₹200 Cr
     Signal 2: segment_name: "Segment B", Segment Revenue ₹150 Cr
   
   Do NOT aggregate segments into a consolidated total within notes_to_accounts signals.

9. Multi-period extraction for notes. ALWAYS extract ALL periods disclosed in notes.
   If a debt schedule shows maturity for next 5 years, emit 5 separate notes_to_accounts
   signals (one per year). If a contingent liability was ongoing for 3 years with amounts
   disclosed each year, emit 3 measures.

10. is_consolidated determination. Set to true if the note is from consolidated notes, false
   if from standalone notes, null if source cannot be determined. Do not infer — only set
   based on explicit labeling.

11. One disclosure → multiple signals permitted. A single paragraph that contains a capex
    announcement, guidance, and milestone simultaneously should emit three separate signals
    with the same source_statement_id.


12. Debt schedule extraction. ALWAYS extract ALL components from debt schedule notes:
    - Maturity buckets (amount due in <1yr, 1-2yr, 2-3yr, >3yr buckets)
    - Interest rates and weighted avg cost of debt
    - Security status breakdown (secured vs unsecured amounts)
    - Lender type mix (banks, bonds, others) if disclosed
    Each should emit a separate financial_figure with category=debt_schedule,
    source_context=notes_to_accounts, source_section="Notes to Accounts Note X (Debt Schedule)".

13. Tax figures extraction. ALWAYS extract these separately:
    - Current Tax Expense (P&L line)
    - Deferred Tax Asset and Deferred Tax Liability (BS lines)
    - Tax Paid (CF Statement)
    - Effective Tax Rate (calculated or disclosed; role=reported if disclosed in notes)
    - Tax reconciliation breakdown from notes (statutory rate, adjustments, effective rate)
    Each emits separate financial_figure with category=tax, multi-period if disclosed.

14. Contingent liability amounts. EMIT TWO SIGNALS from same contingency disclosure:
    - financial_figure: metric=TAX_LIABILITY (or other contingency metric), value=amount,
      role=contingent, category=contingent_liability, source_context=notes_to_accounts
    - contingent_liability: signal with commentary, dispute_description, company_position
    Link via source_statement_id.

15. Related party transaction amounts. EMIT TWO SIGNALS from same RPT disclosure:
    - financial_figure: metric=[RPT metric], value=amount, role=reported,
      category=related_party, source_context=notes_to_accounts
    - governance_signal: signal with nature_of_txn, approval_status, is_arms_length
    Link via source_statement_id.

16. Goodwill and intangible assets. EXTRACT as financial_figure (NOT as string in details):
    - Goodwill created (from acquisition note): metric=GOODWILL, value, unit=Cr,
      role=reported, category=goodwill
    - Goodwill impairment: metric=GOODWILL, role=reported, category=goodwill,
      include impairment amount with negative value
    - Intangible assets (patents, trademarks, software): metric=INTANGIBLE_ASSETS,
      category=goodwill, source_context=financial_statements or notes_to_accounts

17. Capacity and volume extraction. EMIT financial_figure for ALL stated metrics:
    - Installed capacity: metric=[CAPACITY_<UNIT>], value, unit (MW, tonnes, units, etc.),
      category=capacity, source_context=mda or notes_to_accounts
    - Capacity utilisation %: metric=[CAPACITY_<UNIT>_UTIL], value (as %, e.g., 85),
      unit="%", category=capacity
    - Capacity added: metric=[CAPACITY_<UNIT>_ADDED], value, category=capacity
    - Volumes (sold, produced, shipped): metric=[VOLUME_<TYPE>], value, unit=[unit_detail],
      category=volume, source_context=mda
    Example: "Produced 1,000 tonnes" → metric=VOLUME_PRODUCED, value=1000, unit_detail="tonnes",
    category=volume, source_context=mda.

18. Cost structure extraction. EMIT financial_figure for each cost component disclosed as % of revenue:
    - RM as % revenue: metric=RM_PERCENT_REV, value (as number, e.g., 45), unit="%",
      category=cost_structure, source_context=mda
    - Employee cost as % revenue: metric=EMP_COST_PERCENT_REV, value, unit="%"
    - Power/fuel cost as % revenue: metric=POWER_COST_PERCENT_REV, value, unit="%"
    - Other cost breakdowns: similar pattern
    Each emits separate financial_figure.

19. Working capital days extraction. IF explicitly disclosed in MD&A or notes (not calculated):
    - DIO (Days Inventory Outstanding): metric=DIO, value (as number of days, e.g., 45),
      unit="days", category=working_capital, source_context=mda or notes_to_accounts
    - DSO (Days Sales Outstanding): metric=DSO, value, unit="days"
    - DPO (Days Payable Outstanding): metric=DPO, value, unit="days"
    - CCC (Cash Conversion Cycle): metric=CCC, value, unit="days"
    Extract ONLY if explicitly stated. Do NOT calculate from balance sheet.

20. Exceptional items extraction. ALWAYS extract one-time items separately:
    - Asset write-downs: metric=[ASSET_TYPE]_WRITEDOWN, value, unit=Cr,
      category=exceptional_items, source_context=financial_statements
    - Impairment losses: metric=[ASSET_TYPE]_IMPAIRMENT, value, unit=Cr
    - One-time gains/losses: metric=EXCEPTIONAL_GAIN or EXCEPTIONAL_LOSS, value
    Link to earnings_quality signal via source_statement_id to flag impact on headline earnings.

21. Other income breakdown extraction. IF notes disclose components:
    - Interest income: metric=INTEREST_INCOME, value, category=other_income,
      source_context=notes_to_accounts, component_breakdown=true
    - Dividend income: metric=DIVIDEND_INCOME, value, category=other_income,
      component_breakdown=true
    - Gains on investments: metric=INVESTMENT_GAIN, value, category=other_income,
      component_breakdown=true
    - Other income (summary): metric=OTHER_INCOME, value, category=other_income,
      component_breakdown=false (this is the parent)
    Extract each component as separate financial_figure if disclosed.

22. Restatement tracking. WHEN a prior-year figure is restated:
    - Emit TWO measures in same signal: one with role=prior (original figure),
      one with role=restated (corrected figure), or use prior measure with prior_value
      and restatement_note in details
    - Example: If FY24 PAT was originally ₹100 Cr, restated to ₹95 Cr in FY25 AR:
      - Measure 1: role=prior, value=100, value_raw="₹100 Cr (original FY24 PAT)"
      - Measure 2: role=restated, value=95, value_raw="₹95 Cr (restated FY24 PAT)"
      - Details: restatement_note="Note 2 — FY24 exceptional item reclassified"
    - Mark severity=high or impact=high if restatement materially changes prior-year profitability

23. Do not extract as financial_figure (route to other types):
    - Forward-looking targets (use guidance or growth_forecast)
    - Narrative commentary without numbers (use leadership_statement, strategic_claim)
    - Unquantified risks (use risk_factor)
    - Customer or supplier names without transaction amounts (use distribution_customer)

24. Growth rates extraction. ONLY if explicitly stated in management commentary or tables:
    - Identify statements: "Revenue grew X%", "EBITDA up Y bps", "PAT increased Z%"
    - Extract as financial_figure: metric=[METRIC]_GROWTH_RATE, value (as number, e.g., 15 for 15%),
      unit="%", category=growth_rates, source_context=mda or board_report
    - NEVER calculate growth rates from disclosed figures
    - Include details: rate_type (revenue/ebitda/pat/other), is_explicit=true, 
      source_quote=verbatim management statement
    - If growth rate is per-segment, extract separately with segment_name

25. Hedging positions extraction. EXTRACT from derivatives and hedging policy notes:
    
    For FOREX hedges:
    - Extract as financial_figure: metric=FOREX_HEDGE_[CURRENCY], 
      value=notional foreign currency amount (e.g., $5M for USD 5M), unit=USD/EUR/GBP,
      category=hedging_positions, source_context=notes_to_accounts
    - Details: hedge_type="forex", notional_currency=[currency], hedge_rate=[locked rate],
      fair_value=[current FV], mark_to_market=[MTM gain/loss], maturity_date=[end date]
    - Separate signal for fair value change: metric=HEDGE_FV_CHANGE, value=[gain/loss],
      category=hedging_positions
    
    For COMMODITY hedges:
    - Extract as financial_figure: metric=COMMODITY_HEDGE_[TYPE], 
      value=contract volume, unit=[unit_detail], category=hedging_positions
    - Details: hedge_type="commodity", commodity_type=[oil/gold/copper/etc], 
      contract_volume=[qty], volume_unit=[barrels/ounces/tonnes], strike_price=[locked price],
      fair_value=[current FV], maturity_date=[end date]
    
    For INTEREST RATE hedges:
    - Extract as financial_figure: metric=IR_HEDGE_NOTIONAL, value=notional amount,
      unit=Cr, category=hedging_positions
    - Details: hedge_type="interest_rate", fixed_rate=[locked rate], fair_value=[FV],
      maturity_date=[end date]
    
    For all hedges: If mark-to-market or fair value change is disclosed, emit separate
    signal for the gain/loss: metric=HEDGE_GAIN or HEDGE_LOSS, value, source_context=notes_to_accounts

26. Stock options extraction. EXTRACT from stock-based compensation or EPS calculation notes:
    - Extract as financial_figure: metric=ESOP_[OPTIONS/SHARES], value, unit=number_of_options,
      category=stock_options, source_context=notes_to_accounts
    - Emit separate signals for each data point:
      * Options outstanding at year-end: metric=ESOP_OUTSTANDING, value
      * Options granted during year: metric=ESOP_GRANTED, value
      * Options exercised during year: metric=ESOP_EXERCISED, value
      * Options lapsed/cancelled: metric=ESOP_LAPSED, value
      * Shares reserved for issuance: metric=ESOP_SHARES_RESERVED, value
      * WAAP: metric=ESOP_WAAP, value, unit=₹
    - Details for all: option_type=ESOP/ESPS, weighted_avg_exercise_price=[WAAP],
      exercise_price_range=[range], vesting_schedule=[terms]
    - If dilution impact is quantified: metric=ESOP_DILUTION_BPS, value (in bps),
      category=stock_options, details: dilution_impact_on_eps=[verbatim description]

27. Do not extract (general): generic mission / vision / values boilerplate, ESG aspirations 
    without metrics, safe harbour disclaimers, routine board resolution summaries, or section
    headers without substantive disclosure.

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
      "signal_type":         "financial_figure" | "notes_to_accounts" | "guidance" | "growth_forecast" |
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
      "kpi_type":     "customer_kpis" | "industry_specific",
      "denomination": "rupee" | "percentage" | "ratio" | "count" | "other"
    }
  ]
}
`;

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
