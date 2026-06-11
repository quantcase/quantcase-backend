'use strict';

/**
 * PPT signal extraction prompt (V2 schema).
 *
 * Extracts 12 PPT signal categories from investor presentation PDFs.
 * Output uses the SAME generic signal shape as transcript_call_v2 so signals
 * land in the same transcript_signals_v2 table.
 *
 * Key differences from transcript_call_v2:
 *   - source_context carries the PPT signal category (financial_actual,
 *     capex_actual, kpi_actual, …) instead of call sections.
 *   - signal_type maps each category to the nearest transcript enum value.
 *   - All source coordinates use source_slide + source_context instead of
 *     opening_remarks / analyst_qa.
 *
 * {{DATA_BLOCK}} is replaced at runtime by buildDataBlockPpt() — it contains:
 *   - REPORT DATE / FISCAL YEAR END
 *   - AVAILABLE KPIs list
 *   - (no transcript text — the PDF itself is sent as a file attachment)
 */

const PROMPT_TEMPLATE_PPT = `QUANTCASE — PPT SIGNAL EXTRACTION PROMPT

PURPOSE
Extract structured investment signals from an investor presentation (PPT/PDF).
Source type for all signals: "ppt".

Extract signals across all 12 categories defined below.
Every signal must carry:
  • source_context  — the PPT signal category (e.g. "financial_actual", "kpi_actual")
  • source_slide    — slide number in details.source_slide
  • statement       — verbatim text from the slide, no paraphrasing

{{DATA_BLOCK}}

----------------------

## THE GENERIC SIGNAL SHAPE

Every signal uses the SAME object shape regardless of PPT category.

ENVELOPE (always present)
  signal_id            unique within this run
  source_statement_id  links signals that came from the same slide/table row
  source_context       PPT category slug — one of the 12 values listed below
  signal_type          mapped transcript enum value — see SIGNAL TYPE MAPPING
  impact               "high" | "medium" | "low"
  severity             "critical" | "high" | "medium" | "low" | "informational"
  statement            verbatim text from the PPT slide — no paraphrasing

COMMON FIELDS (fill the ones that apply; otherwise null)
  category        sub-classification within the signal_type (see per-type allowed values)
  metric          KPI abbr (see KPI ABBREVIATION RULES)
  topic           short descriptive label (e.g. "revenue_growth", "NIM_trajectory")
  description     short free-text explanation (max 20 words)
  direction       directional label — allowed values differ by type
  horizon         "near_term" (0–12m) | "medium_term" (1–3y) | "long_term" (3y+) | null
  timeline        free-text "when" where no precise date is given
  segment_name    segment / subsidiary name
  is_segment_level true if this signal is segment/subsidiary level, not consolidated

measures[] — list of numeric facts. Use for EVERY value/figure/unit/period.
  Each measure:
    role        what this number is (see roles below)
    value        decimal | null — no units, no commas; null if qualitative
    value_raw    string  | null — verbatim figure as shown ("₹1,234 Cr", "15.2%")
    unit         "Cr" | "%" | "x" | "₹" | null
    multiplier   integer | null — 10000000 for Crores | 100000 for Lakhs | 1 for ratios/%
    period       { start, end, type } | null
                   start / end : ISO YYYY-MM-DD | null
                   type        : "quarterly" | "half_yearly" | "annual" | "ttm" |
                                 "snapshot" | "guidance" | "base" | "target" | null

  measure ROLES:
    reported          actual/historical figure for a completed period
    guided            forward-looking guided figure
    baseline          current/base figure a guidance is measured from
    value             generic market/industry figure
    quantum           amount of capital deployed
    scale             opportunity/target size
    growth_rate       growth rate (store as decimal: 0.15 = 15%)
    absolute_target   guided absolute target value
    current           current-period figure (for quality comparisons)
    prior             prior-period / base figure
    revised           revised guidance figure
    actual            realized outcome of a prior guidance
    claimed           figure management claims as achieved

details{} — type-specific extras plus PPT-specific coordinate fields.
  source_slide       integer — slide number where this signal was found
  source_context_raw verbatim slide title or section label

----------------------

## DATE FORMATTING RULES
- All dates: YYYY-MM-DD format.
- Resolve vague periods to the LAST DAY of the implied period using REPORT DATE and FISCAL YEAR END:
  - "FY25" → last day of FY25 (based on fiscal year end)
  - "Q3FY25" → last day of Q3 relative to fiscal year end
  - "H1FY25" → last day of H1 of the fiscal year
  - "near term" → 6 months from REPORT DATE
  - "medium term" → 18 months from REPORT DATE
  - "long term" → 36 months from REPORT DATE
- Comparative periods (FY25/FY24/FY23): extract all with correct dates.
- If truly unresolvable: null.

----------------------

## KPI ABBREVIATION RULES
1. Always check AVAILABLE KPIs first. Use the exact abbr from that list.
2. If not in the list → add to new_kpis and use the abbr you assign there.
3. KPI abbrs are TIMELESS — never embed a period, quarter, or year in the abbr.
   Use REV not REV_FY25; use EBITDA not EBITDA_9M.
4. Segment KPIs: prefix SEG_<SEGMENT>_<ABBR> (e.g. SEG_RETAIL_REV).
   Always register in new_kpis if not already in AVAILABLE KPIs.
5. Label metrics exactly as stated in the PPT — do not standardize or rename.
   If PPT says "Reported EBITDA" and "Adjusted EBITDA", register both separately.

----------------------

## SIGNAL TYPE MAPPING

Each of the 12 PPT categories maps to a signal_type from the transcript enum.
Use source_context to carry the PPT category; use signal_type for the mapped value.

  PPT category            → signal_type           Notes
  ─────────────────────────────────────────────────────────────────────────────
  financial_actual        → kpi                   P&L / Balance Sheet / Cash Flow actuals
  capex_actual            → kpi                   Capital expenditure actually spent (metric_family="capital")
  kpi_actual              → kpi                   Operational / business KPIs
  customer_concentration  → distribution_customer  Revenue distribution across customers/segments
  distribution_channels   → distribution_customer  Go-to-market model and channel mix
  product_technology      → milestone              Completed launches / actual R&D spend
  competitive_landscape   → competitive_position   Market position, peer comparison, industry trends
  disclosure_quality      → disclosure_quality     Exceptional items, RPTs, auditor flags
  industry_signals        → industry_signal        Sector-wide, industry-level data
  capital_allocation      → capital_allocation     Dividends, buybacks, debt management, M&A
  earnings_quality        → earnings_quality       Durability / sustainability of reported earnings
  future_target           → guidance               All guidance, targets, and forward plans

  Special sub-mapping within future_target:
    If the target includes a growth rate → also emit a growth_forecast signal
    (same source_statement_id, different signal_id)

----------------------

## PPT SIGNAL CATEGORIES — EXTRACTION RULES

### CATEGORY 1: financial_actual  [signal_type: kpi]
Extract all numeric financial data from P&L, Balance Sheet, and Cash Flow statements only.
Every number must be mapped to a specific date with its unit.
Capture both absolute values (₹ Cr, ₹/share) and growth rates (YoY, QoQ, CAGR).
Label metrics exactly as stated — do not standardize or rename.

P&L: Revenue/Net Sales, COGS, Gross Profit/Margin, OpEx, EBITDA (Reported vs. Adjusted vs. ProForma),
     D&A, Interest/Finance Costs, Tax Expense/Effective Rate, PAT, EPS, Diluted EPS
Cash Flow: Operating Cash Flow, Investing Cash Flow, Financing Cash Flow, Free Cash Flow (OCF − Capex),
           Cash Conversion Ratio (OCF ÷ PAT)
Balance Sheet: Total Assets, Total Liabilities, Shareholders' Equity, Current Assets/Liabilities/Working Capital,
               Total Debt/Borrowings, Cash & Equivalents, Net Debt

Rules:
  • If PPT shows comparative periods (FY25/FY24/FY23), extract ALL periods.
  • If "Reported EBITDA" and "Adjusted EBITDA" both shown, extract both.
  • Include one-time items, write-downs, adjustments noted in statements.
  • Margins: extract if shown; if not shown, set value: null, value_raw: "Not disclosed".
  • Do NOT include operational metrics (volumes, store counts, capacity) — those are kpi_actual.

category: "profitability" | "cash_flow" | "balance_sheet"
details.metric_family: "profitability" | "growth" | "capital" | "asset_quality" | "customer" | "order_pipeline" | "industry"


### CATEGORY 2: capex_actual  [signal_type: kpi, metric_family: "capital"]
Extract all capital expenditure actually spent in the reporting period.
Every figure mapped to a date with its unit and growth rate.
Segment by any dimension disclosed (type, segment, geography, project).

Extract: Total Capex, Maintenance vs. Growth Capex, Capex by segment/geography/asset type/project,
         Capex as % of revenue, Capex as % of EBITDA, Capex-to-depreciation ratio,
         Asset additions/Gross block created

Rules:
  • Actuals only — forward capex budgets/guidance go in future_target.
  • Distinguish capex committed-but-not-spent from capex spent (note in details.source_context_raw).
  • If capacity addition linked to capex (e.g., "₹600 Cr added 500 MW"), capture both.
  • "₹150 Cr planned for EV charging by 2027" → future_target, NOT capex_actual.

category: "total" | "maintenance" | "growth" | "segment" | "ratio"
details.metric_family: "capital"


### CATEGORY 3: kpi_actual  [signal_type: kpi]
Extract ALL operational and business-specific KPIs — volumes, capacity, customer metrics,
asset quality, and any sector-specific indicator not in financial statements.
Every KPI: metric name + absolute value + unit + growth rate.

By sector (non-exhaustive — extract everything disclosed):
  Oil & Gas: Production volumes (MMTPA, MMCFD, BOE/day), capacity utilization, reserve replacement ratio,
             proven reserves, reserve life index, lifting cost
  Banking: Total deposits, CASA ratio, gross/net advances, NPA (₹ Cr and %), PCR, NIM,
           cost-to-income, ROA/ROE, yield on advances, cost of deposits,
           customer/branch/ATM counts, digital penetration
  Retail/E-commerce: Store count (owned vs. franchised), LFL sales growth, revenue per store, AOV,
                     customer base, repeat rate, e-commerce %, app users, inventory turnover/days
  Manufacturing: Production volume, capacity, capacity utilization, order book (₹ Cr + book-to-revenue ratio),
                 machine uptime, labor productivity
  Power/Utilities: Installed capacity, energy generated, PLF/capacity factor, renewable capacity and %,
                   ASP (₹/unit), T&D losses, collection efficiency, consumer count
  Pharma: Drug pipeline by phase, approvals, patents filed, facility utilization,
          distributor/sales force count, regulatory compliance status
  IT Services: Headcount, billable headcount, attrition, utilization rate, client count, client retention,
               large deal wins, vertical/offshore-onshore revenue mix
  FMCG: Distributor count, geographic penetration (states/districts), urban/rural mix,
        modern/traditional trade mix, production capacity, plant utilization
  Insurance: GWP, net premiums, claims/loss/combined/expense ratios, policy count, lapse rate, digital penetration
  Telecom: Subscribers, ARPU, churn, 4G/5G penetration, data usage/user, network coverage, MOU
  Real Estate: Land bank, completed/ongoing/pipeline projects, occupancy rate, price per sq. ft., collection efficiency
  Hospitality: Properties/rooms, occupancy, ADR, RevPAR
  Logistics: Fleet size, utilization, network coverage, warehousing capacity, on-time delivery, cost per unit
Always check (all sectors): Market share %, pricing/ASP, volume trends, headcount/attrition,
                             safety metrics, ESG/environmental metrics, regulatory compliance

Rules:
  • Extract EVERY operational metric.
  • If KPI shown as % only, also capture absolute numbers if available.
  • Do NOT include P&L/Balance Sheet/Cash Flow items (category 1) or ratios derived from them.
  • Do NOT include forward targets (category 12).
  • Peer benchmark KPI data: capture if shown, set details.is_peer_benchmark: true.

category: any short sector-relevant label (e.g. "banking_asset_quality", "retail_store_network")
details.metric_family: "profitability" | "growth" | "capital" | "asset_quality" | "customer" | "order_pipeline" | "industry"
details.is_peer_benchmark: boolean — true if this is a peer/industry comparison figure


### CATEGORY 4: customer_concentration  [signal_type: distribution_customer]
Extract the distribution of revenue across customers and segments.

Extract: Named top customers (revenue ₹ Cr + % of total + growth %), unnamed customers as "Top customer #1" etc.,
         Top 2/3/5 cumulative %, customer segment mix (OEM/Retail/B2B/Government),
         customer type breakdown (Large/Mid/SME), geographic split (Domestic/Export by region),
         industry segment split, long-term vs. spot contract %, contract duration,
         customer churn/retention/acquisition metrics, ARPU, LTV, CAC

Rules:
  • Extract both revenue ₹ Cr AND % — not one without the other.
  • If no concentration numbers disclosed, note "Not disclosed" in description — do not assume.
  • Include contract terms if shown (lock-in period, pricing mechanism).

category: "named_customer" | "segment_mix" | "geographic_split" | "contract_terms" | "retention_metrics"
direction: "entering" | "expanding" | "exiting" | "maintaining"


### CATEGORY 5: distribution_channels  [signal_type: distribution_customer]
Extract the go-to-market model, channel revenue split, partner network scale, and unit economics per channel
as of the report date.

Extract:
  Channel mix: Revenue % and growth % per channel (Direct B2B, Wholesale/Distributors,
               Retail owned/franchised, E-commerce, Export)
  Channel economics: Gross/operating margin per channel, payment terms, contract duration, customer stickiness
  Direct B2B: Revenue ₹ Cr + %, enterprise customer count, ACV, retention rate
  Wholesale/Distributor: Revenue ₹ Cr + %, distributor count and growth, geographic coverage,
                         avg sales per distributor, distributor margin/rebate %, distributor concentration (top 5 %)
  Retail: Revenue ₹ Cr + %, owned vs. franchised outlet count, revenue per store, avg store area,
          LFL growth %, franchisee economics (investment, payback, royalty)
  E-commerce: Revenue ₹ Cr + %, marketplace presence, registered users, CAC, AOV
  Export: Revenue ₹ Cr + %, destination countries, direct vs. indirect split

Rules:
  • Actual network as of report date only — expansion plans go in future_target.
  • If franchise model: always capture franchisee count, avg investment, payback, royalty if available.
  • If margin by channel shown, always extract.

category: "channel_mix" | "direct_b2b" | "wholesale_distributor" | "retail" | "ecommerce" | "export"
direction: "entering" | "expanding" | "exiting" | "maintaining"


### CATEGORY 6: product_technology  [signal_type: milestone]
Extract product portfolio composition, new launches COMPLETED in the reporting period,
actual R&D/tech spend, and digital initiative progress.

Extract: Product lines (name + revenue % + growth % + margin profile),
         new products launched in period (name, launch date, geography, capex),
         R&D spend ₹ Cr + % of revenue (actual, not budgeted),
         digital initiatives (investment ₹ Cr + adoption % + revenue impact %),
         patent count (filed/total), technology platforms/IP,
         technology partnerships (partner, scope, expected impact),
         total SKU count and net change, product quality metrics

Rules:
  • New launches: only if completed in reporting period — planned launches go in future_target.
  • R&D: actual spend in period only — future R&D budgets go in future_target.
  • Digital: capture both investment AND impact metrics (adoption %, revenue uplift %).
  • Do NOT extract product pricing.

category: "financial_performance" | "operational_achievement" | "strategic_progress" | "comparative_claim" | "other"


### CATEGORY 7: competitive_landscape  [signal_type: competitive_position]
Extract market position, competitive dynamics, industry trends, regulatory environment,
and competitive advantage indicators.

Extract: TAM (₹ Cr/units), market size growth %, company market share (% + trend + bps change + historical),
         peer comparison (2–3 direct competitors: name, market share %, EBITDA margin %, capex intensity %, growth %),
         competitive positioning statement, industry trends (name + current state + quantified impact + company response),
         regulatory environment (regulation name + status + financial impact ₹ Cr + compliance status),
         pricing power assessment (Strong/Moderate/Weak + rationale), cost structure competitiveness,
         supply chain risk level, competitive moat indicators (brand, IP, scale, network effects, switching costs),
         new entrant threat

Rules:
  • Actuals/historical data only — peer guidance goes in future_target.
  • If market size not disclosed, set value: null, value_raw: "Not disclosed" — do not estimate.
  • Scan appendix and risk sections for regulatory impacts.
  • Distinguish peer historical performance from peer guidance.

category: "pricing_power" | "cost_structure" | "distribution" | "product" | "brand" | "market_share"
direction: "improving" | "stable" | "declining"
details.relative_to: "peers" | "historical" | "market"


### CATEGORY 8: disclosure_quality  [signal_type: disclosure_quality]
Extract financial disclosures that signal earnings quality, hidden risks, or aggressive accounting.

Extract:
  One-time/exceptional items: description, ₹ Cr value (+ = gain, − = charge), % of reported PAT,
                              recurrence risk (High/Medium/Low), period
  Provisions/contingencies: description, ₹ Cr, timeline, probability if disclosed,
                            status (Provided/Contingent/Under dispute)
  Related-party transactions: transaction type, counterparty name, ₹ Cr value, pricing terms,
                              conflict of interest flag, governance oversight noted
  Auditor observations: observation/matter of emphasis, severity (Critical/Alert/None), auditor conclusion
  Accounting conservatism: High/Medium/Low + rationale
  Accounting policy changes: policy name, changed in period (Yes/No), ₹ Cr PAT impact if quantified
  Impairment charges: asset description, ₹ Cr, reason
  Litigation/disputes: description, ₹ Cr at risk, status, probability of loss
  Other: restatements/reclassifications, off-balance-sheet items (SPVs, unrecognized leases),
         connected party relationships, change in estimates with material impact

category: "proactive_bad_news" | "reactive_bad_news" | "proactive_good_news" |
          "selective_omission" | "auditor_or_regulatory_flag" | "key_mgmt_change"
details.trigger: "unsolicited" | "analyst_question" | "inferred_from_data"
details.severity_of_issue: "critical" | "high" | "medium" | "low"


### CATEGORY 9: industry_signals  [signal_type: industry_signal]
Extract all sector-wide, industry-level data — NOT company-specific.
Capture global and domestic industry metrics, growth drivers, structural shifts,
and regulatory/competitive dynamics.

Extract:
  Size & growth: Industry TAM (global + domestic), growth rate (actuals), historical CAGR,
                 growth forecast (FY26–27), segment breakdown (% share of sub-segments),
                 India penetration/maturity
  Dynamics: Volume trends, pricing trends, consolidation activity, technology disruption,
            customer behavior shifts, supply chain changes, labor/wage trends, regulatory shifts,
            ESG trends, margin trends, competition intensity
  Structure: Player count, market concentration (top 3/5 share %), M&A activity, new entrant threat,
             industry-average EBITDA margin/capex intensity/ROE/leverage/cash conversion
  Global vs. domestic: Global TAM, global growth rate, India vs. global growth differential,
                       pricing gaps, technology cascade timeline
  Outlook: Industry growth forecast (FY26–27 CAGR), margin outlook, capex cycle direction,
           key catalysts and headwinds, consolidation outlook, demand elasticity/cyclicality

Sector-specific metrics: extract if disclosed (same list as kpi_actual sector guide above)

category: "demand" | "supply" | "competition" | "ma_activity" | "regulatory" | "global" | "macro"
direction: "positive" | "negative" | "neutral" | "uncertain"
horizon: yes
details.drivers: string[] — up to 5 driver phrases


### CATEGORY 10: capital_allocation  [signal_type: capital_allocation]
Extract how the company deployed capital in the reporting period.

Extract: Dividend paid ₹ Cr, DPS (₹), payout ratio %, dividend frequency (interim/final),
         buyback ₹ Cr + shares repurchased, net debt reduction ₹ Cr,
         net debt (₹ Cr + trend vs. prior year), debt-to-EBITDA (x), debt-to-equity (%),
         interest coverage (EBITDA ÷ Interest), capex by segment (% allocation),
         M&A activity (deal description + ₹ Cr + rationale + integration status),
         cash balance ₹ Cr, OCF ₹ Cr, FCF ₹ Cr, cash conversion (OCF ÷ PAT),
         working capital change (₹ Cr impact on cash), capex intensity (% of revenue),
         capex-to-depreciation ratio, capital allocation policy framework (if stated)

Rules:
  • Actual capital deployed in reporting period only — forward allocation targets go in future_target.
  • Track both absolute net debt and leverage ratios.
  • Always capture OCF vs. FCF separately (indicates earnings quality).

category: "capex" | "ma" | "debt_management" | "shareholder_returns" | "r_and_d"
details.return_expectation: string | null


### CATEGORY 11: earnings_quality  [signal_type: earnings_quality]
Synthesize financial data into an assessment of how durable and sustainable reported earnings are.
Draw from financials, disclosures, and competitive position.

Extract:
  Revenue sustainability: organic vs. acquired growth %, revenue mix (recurring/contract/spot/project),
                          pass-through pricing mechanisms (% of revenue covered),
                          customer retention/churn, contract duration/revenue visibility
  EBITDA quality: recurring EBITDA % (ex-one-time), operating leverage (margin expansion from scale),
                  segmental margin trends, EBITDA predictability/volatility
  PAT quality: operating leverage (PAT growth vs. revenue growth), tax rate normalization,
               one-time impact as % of reported PAT + recurrence risk
  Cash conversion: OCF ÷ PAT ratio (>1x = healthy), comparison to prior year,
                   working capital OCF impact, FCF sustainability
  Margin trajectory: Gross/EBITDA/PAT margin trend (improving/flat/declining + bps YoY) + drivers
  Earnings visibility: order book/backlog (months of revenue), guidance track record,
                       industry cyclicality assessment
  Red flags: declining cash conversion, recurring one-time items, margin compression despite revenue growth,
             rising working capital needs, customer concentration risk, aggressive revenue recognition

category: "cash_conversion" | "working_capital" | "one_time_item" | "accounting_change" |
          "margin_sustainability" | "trend_financial" | "revenue_recognition" |
          "contingent_liability" | "tax_anomaly" | "balance_sheet_health" | "seasonality"
direction: "improving" | "deteriorating" | "stable" | "uncertain"
details.impact_on_reported_earnings: "overstates" | "understates" | "negative" | "positive" | null


### CATEGORY 12: future_target  [signal_type: guidance; also growth_forecast if numeric]
Extract ALL guidance, targets, and forward plans. Nothing historic or current.
Capture timeline and quantification for every forward statement.

Categorize each target under:
  Financials | KPI | Capex | Capital Allocation | Completion | Product |
  Customer | Distribution | Earnings Quality | Industry

Extract: Revenue/EBITDA/PAT/EPS guidance (₹ Cr or CAGR %),
         margin targets, KPI targets (production volumes, store counts, CASA %, subscriber targets),
         capacity expansion targets, market share targets, capex guidance (total + by segment),
         debt/leverage targets, dividend policy/guidance, ROIC/ROE/FCF targets,
         product launch pipeline, geographic expansion plans, M&A targets,
         technology/digital targets, ESG/sustainability targets (Net-zero, renewable % by year),
         cost reduction targets, efficiency improvement targets

Rules:
  • Distinguish explicit guidance ("will", "target", "guidance") from aspirational ("aspire", "long-term vision").
  • Always note timeline (FY26, FY27, CY2030, etc.) — use details.timeline_raw for verbatim text.
  • For CAGR guidance: state base and end year (e.g., "FY25–FY27 CAGR", not just "CAGR").
  • Confidence level: "Firm" (management sounds certain) vs. "Moderate/Tentative" ("aim to", "expect to").
  • Extract only what's stated in PPT — do not infer targets from strategy slides.
  • If target includes a growth rate, emit an additional growth_forecast signal with the same source_statement_id.

category: "quantitative" | "qualitative_directional" | "timeline_milestone"
details.is_conditional: boolean
details.condition: string | null
details.confidence_level: "committed" | "aspirational" | "directional"
details.timeline_raw: string | null — verbatim timeline text (e.g., "by FY27", "over 3 years")

----------------------

## IMPACT & SEVERITY RULES
Assign to every signal.

impact — materiality for investment decision-making:
  "high"   — thesis-changing: major guidance, structural trend, earnings quality concern affecting reported profits
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

1. Verbatim is non-negotiable. The statement field must be exact text from the slide.
   Never paraphrase, summarize, or reword. If you cannot find the exact text, do not create the signal.

2. Units always: ₹ Cr, %, MMTPA, stores, MW, etc. — capture the unit exactly as shown.

3. Growth rates always: capture absolute value AND YoY/QoQ/CAGR where shown.

4. Source tag every signal: details.source_slide (slide number) + details.source_context_raw (slide title/section).

5. No assumptions: if data not shown, set value: null — do not infer or estimate.

6. Actuals vs. guidance: categories 1–11 = actuals/historical only; category 12 = forward guidance only.

7. Completeness is critical: do not omit any metric — extract everything disclosed.

8. Margins: extract if shown; if not shown, set value: null, value_raw: "Not disclosed".

9. Comparative periods: if PPT shows FY25/FY24/FY23, emit one signal (or measure) per period.

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly two top-level keys.
No markdown fences. No explanation. JSON only.

{
  "signals": [
    {
      "signal_id":           string,
      "source_statement_id": string,
      "source_context":      "financial_actual" | "capex_actual" | "kpi_actual" |
                             "customer_concentration" | "distribution_channels" |
                             "product_technology" | "competitive_landscape" |
                             "disclosure_quality" | "industry_signals" |
                             "capital_allocation" | "earnings_quality" | "future_target",
      "signal_type":         "guidance" | "industry_signal" | "capital_allocation" |
                             "disclosure_quality" | "distribution_customer" | "growth_forecast" |
                             "earnings_quality" | "kpi" | "mgmt_tone" | "analyst_questions" |
                             "guidance_revision" | "pricing_power" | "competitive_position" |
                             "milestone" | "ongoing",
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

      "details": {
        "source_slide":        number | null,
        "source_context_raw":  string | null
      }
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

function buildDataBlockPpt(existingKpis, reportDate, fiscalYearEnd = '03-31') {
  const kpiReference = existingKpis.map(k => {
    const denom = k.denomination ? ` [${k.denomination}]` : '';
    return `${k.abbr} — ${k.full_form}${denom}`;
  }).join('\n  ');

  return `REPORT DATE: ${reportDate ?? 'unknown'}
FISCAL YEAR END (MM-DD): ${fiscalYearEnd}

## AVAILABLE KPIs
Use the exact abbr from this list when referencing any KPI metric in signals.
If a KPI is not listed here, add it to new_kpis and use the abbr you assign.

  ${kpiReference}`;
}

function pptExtractorPromptV2(existingKpis, reportDate, fiscalYearEnd = '03-31') {
  const dataBlock = buildDataBlockPpt(existingKpis, reportDate, fiscalYearEnd);
  return PROMPT_TEMPLATE_PPT.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { pptExtractorPromptV2, buildDataBlockPpt, PROMPT_TEMPLATE_PPT };
