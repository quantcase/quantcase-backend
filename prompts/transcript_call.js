'use strict';

/**
 * PROMPT_TEMPLATE — static instructional portion stored in the DB (skills.prompt_template).
 * Dynamic runtime data is injected at {{DATA_BLOCK}} by the worker.
 *
 * To edit the prompt without a code deploy: update the `prompt_template` column on the
 * `summarization` skill row in the database.
 */
const PROMPT_TEMPLATE = `You are an expert financial analyst extracting structured signals from an earnings call transcript.
Your job is to identify every signal that may be useful for future analysis of management quality, opportunity sizing, deal valuation, governance, and industry positioning.

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

## SIGNAL TYPES

Extract ALL of the following signal types. Every signal goes into the single \`extracted_signals\` array.

### signal_type: "kpi"
Numeric financial or operational KPIs mentioned in the transcript — company-wide or segment-level.
- metric: KPI abbreviation (use AVAILABLE KPIs list; if new, register in new_kpis and use the abbr you assign)
- For segment/subsidiary KPIs prefix with SEG_<SEGMENT>_ (e.g. SEG_ARI_REV). Never reuse a base abbr for a non-consolidated figure.
- metric_family: "profitability" | "growth" | "capital" | "customer" | "industry"
- value: decimal number (no units/commas), null if not numeric
- raw_value: value as string exactly as found in text
- unit: "Cr" | "%" | "x" | "₹" | null
- multiplier: integer scale factor (10000000 for Crores, 100000 for Lakhs, 1 for ratio/%)
- start_date / end_date: ISO dates covering the period; null for point-in-time
- period_type: "quarterly" | "half_yearly" | "annual" | "ttm" | "snapshot" | "cumulative"
- statement: verbatim quote from transcript

### signal_type: "governance"
Board transparency, disclosure quality, capital allocation signals.
- metric: "transparent" | "defensive_language" | "capital_allocation_clarity" | "proactive_disclosure" | "forced_disclosure" | "guidance_given" | "guidance_missed" | "related_party_concern" | "auditor_remark"
- metric_family: "governance"
- value: 1 (signal present / true) | 0 (absent / false) | null
- raw_value: short description or quote (max 20 words)

### signal_type: "entity"
Named entities extracted from the transcript.
- metric: "person" | "business_segment" | "geography" | "customer" | "competitor" | "partner"
- metric_family: "qualitative"
- value: null
- raw_value: the entity name or short description

### signal_type: "milestone"
Forward-looking targets (future_goals), disclosed successes (success_disclosures), and admitted failures (failure_disclosures).
- metric: KPI abbreviation (same rules as kpi signals — use AVAILABLE KPIs or new_kpis; SEG_ prefix for segment targets)
- metric_family: "milestone"
- value: targeted_value (decimal), null if not numeric
- raw_value: current_value as string (the baseline at time of call), null if unavailable
- unit / multiplier: same rules as kpi signals
- start_date: when target was announced (YYYY-MM-DD)
- end_date: when target is expected to be achieved (YYYY-MM-DD)
- statement: verbatim quote
- Additional field "milestone_category": "future_goal" | "success_disclosure" | "failure_disclosure"

### signal_type: "industry"
Industry-level demand, supply, and operating margin signals (not company-specific).
- metric: KPI abbreviation or short label (e.g. "industry_demand_cagr", "capacity_utilisation")
- metric_family: "industry"
- value: numeric if available, else null
- raw_value: short description
- factors_affecting: comma-separated qualitative drivers (max 5, each max 8 words) — put in raw_value if value is null

### signal_type: "customer"
Customer traction signals — growth, churn, revenue per user, cohort quality.
- metric: KPI abbreviation (use AVAILABLE KPIs or new_kpis) or short label (e.g. "churn_rate", "active_customers", "nps")
- metric_family: "customer"
- value: decimal if numeric, null otherwise
- raw_value: verbatim figure or description
- unit / multiplier / start_date / end_date / period_type: same rules as kpi signals

### signal_type: "financial_health"
Qualitative financial strength drivers — NOT numeric KPIs (those go in kpi signals).
- metric: "fcf_quality" | "operating_leverage" | "working_capital_trend" | "debt_trajectory" | "capital_structure" | "revenue_growth_drivers" | "margin_expansion_drivers"
- metric_family: "qualitative"
- value: null
- raw_value: concise driver description (max 20 words)

### signal_type: "tone"
Overall management communication tone for this call.
- metric: "overall_tone"
- metric_family: "qualitative"
- value: null
- raw_value: "confident" | "neutral" | "defensive" | "promotional"
- Emit exactly ONE tone signal per call.

----------------------

## IMPACT & SEVERITY RULES (assign to EVERY signal)

**impact** — materiality of this signal for investment decision-making:
- "high"   — significantly affects thesis (major revenue miss, guidance cut, governance red flag, large milestone)
- "medium" — noteworthy but not thesis-changing
- "low"    — minor or confirmatory

**severity** — urgency / risk level (use for negative signals; for positive signals default to "informational"):
- "critical"     — immediate risk (fraud concern, covenant breach, regulatory action)
- "high"         — serious risk that needs monitoring
- "medium"       — moderate concern
- "low"          — minor concern
- "informational" — no risk, neutral or positive signal

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly two top-level keys:

\`\`\`
{
  "extracted_signals": [
    {
      "signal_type": string,         // controlled vocab above
      "metric": string,              // KPI abbr or metric label
      "metric_family": string,       // controlled vocab above
      "value": number | null,
      "raw_value": string | null,
      "unit": string | null,
      "multiplier": number,          // default 1
      "start_date": string | null,   // YYYY-MM-DD
      "end_date": string | null,     // YYYY-MM-DD
      "period_type": string | null,
      "statement": string | null,    // verbatim evidence quote
      "impact": "high" | "medium" | "low",
      "severity": "critical" | "high" | "medium" | "low" | "informational",
      "time_horizon": "short" | "medium" | "long" | null,
      "esg_tag": string | null,
      "risk_tag": string | null,
      "milestone_category": "future_goal" | "success_disclosure" | "failure_disclosure" | null
    }
  ],
  "new_kpis": [
    {
      "abbr": string,
      "full_form": string,
      "kpi_type": "customer_kpis" | "industry_specific",
      "denomination": "rupee" | "percentage" | "ratio" | "other"
    }
  ]
}
\`\`\`

## RULES
1. Extract ALL signals — err on the side of inclusion; downstream lenses will filter.
2. Every signal must have impact and severity.
3. Never hallucinate KPI abbrs. Unrecognised KPIs go to new_kpis first, then reference by the abbr you assigned.
4. Segment KPIs: SEG_<SEGMENT>_<ABBR> — always register in new_kpis if not in AVAILABLE KPIs.
5. financial_health signals carry NO numeric value — put drivers in raw_value.
6. Return ONLY the JSON. No explanation, no markdown fences.`;

/**
 * Assemble the runtime data block (call metadata + KPI reference + transcript).
 *
 * @param {string} transcriptText
 * @param {Array<{abbr, full_form, kpi_type?, denomination?, source}>} existingKpis
 * @param {string} callDate
 * @param {string} [fiscalYearEnd="03-31"]
 * @returns {string}
 */
function buildDataBlock(transcriptText, existingKpis, callDate, fiscalYearEnd = '03-31') {
  const kpiReference = existingKpis.map(k => {
    const parts = [k.full_form];
    if (k.kpi_type)     parts.push(`kpi_type: ${k.kpi_type}`);
    if (k.denomination) parts.push(`denomination: ${k.denomination}`);
    parts.push(`source: ${k.source}`);
    return `${k.abbr} (${parts.join(', ')})`;
  }).join('\n  ');

  return `CALL DATE: ${callDate}
FISCAL YEAR END (MM-DD): ${fiscalYearEnd}

TRANSCRIPT:
${transcriptText}

----------------------

## AVAILABLE KPIs (from database)
Use the exact \`abbr\` from this list when referencing any KPI in extracted_signals.
If a KPI is not listed here, add it to new_kpis and reference by the abbr you assign there.

  ${kpiReference}`;
}

/**
 * Build the full transcript extractor prompt.
 *
 * @param {string} transcriptText
 * @param {Array<{abbr, full_form, kpi_type?, denomination?, source}>} existingKpis
 * @param {string} callDate
 * @param {string} [fiscalYearEnd="03-31"]
 * @param {string|null} [dbTemplate=null]
 * @returns {string}
 */
function transcriptExtractorPrompt(transcriptText, existingKpis, callDate, fiscalYearEnd = '03-31', dbTemplate = null) {
  const dataBlock = buildDataBlock(transcriptText, existingKpis, callDate, fiscalYearEnd);
  const template  = dbTemplate ?? PROMPT_TEMPLATE;
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { transcriptExtractorPrompt, buildDataBlock, PROMPT_TEMPLATE };
