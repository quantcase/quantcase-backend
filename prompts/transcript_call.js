/**
 * @param {string} transcriptText
 * @param {Array<{id: string, abbr: string, full_form: string, kpi_type?: string, denomination?: string, source: 'QE'|'transcript'}>} existingKpis
 * @param {string} callDate - ISO date string of the earnings call e.g. "2024-11-14"
 * @param {string} [fiscalYearEnd="03-31"] - MM-DD, e.g. "03-31" for Indian FY
 */
function transcriptExtractorPrompt(transcriptText, existingKpis, callDate, fiscalYearEnd = "03-31") {
  const kpiReference = existingKpis.map(k => {
    const parts = [k.full_form];
    if (k.kpi_type)    parts.push(`kpi_type: ${k.kpi_type}`);
    if (k.denomination) parts.push(`denomination: ${k.denomination}`);
    parts.push(`source: ${k.source}`);
    return `${k.abbr} (${parts.join(', ')})`;
  }).join('\n  ');

  return `You are an expert financial analyst extracting structured intelligence from an earnings call transcript to assess management integrity, disclosure quality, and industry positioning.

CALL DATE: ${callDate}
FISCAL YEAR END (MM-DD): ${fiscalYearEnd}

TRANSCRIPT:
${transcriptText}

----------------------

## AVAILABLE KPIs (from database)
When referencing any KPI in your output, always use its exact \`abbr\` from this list:

  ${kpiReference}

If you encounter a KPI that is NOT in the above list, do NOT invent an abbr. Instead, collect it in the \`new_kpis\` array (schema defined below) and reference it by the abbr you assign there.

----------------------

## DATE FORMATTING RULES
- All dates must be in YYYY-MM-DD format.
- If a date is vague, resolve it to the LAST DAY of the implied period:
  - "next fiscal year" → last day of the next fiscal year based on FISCAL YEAR END
  - "by Q3" → last day of Q3 relative to the fiscal year end
  - "H1" → last day of the first half of the fiscal year
  - "near term" / "shortly" → 6 months from CALL DATE
  - "medium term" → 18 months from CALL DATE
  - "long term" → 36 months from CALL DATE
- If truly unresolvable, use null.

----------------------

## OUTPUT SCHEMA

Return ONLY a valid JSON object with the following top-level keys:

### 1. entities
{
  "people": [{ "name": string, "role": string }],
  "business_segments": [string],
  "geographies": [string]
}

### 2. milestones
Organized into three sub-keys: future_goals, failure_disclosures, success_disclosures.
Each has financial_targets and conceptual_targets arrays.

**Financial Target Object:**
{
  "statement": string,              // Full natural language description
  "kpi_abbr": string,               // Must match an abbr from AVAILABLE KPIs or new_kpis
  "current_value": number | null,   // Decimal only, no units/currency text, use absolute values
  "targeted_value": number | null,  // Decimal only, no units/currency text, use absolute values
  "multiplier": number,             // Scale factor for current_value and targeted_value (e.g. 10000000 for Crores, 100000 for Lakhs, 1 for ratios/%)
  "initial_time": "YYYY-MM-DD",     // When this target was first announced
  "target_time": "YYYY-MM-DD"       // When it is/was expected to be achieved
}

**Conceptual Target Object:**
{
  "statement": string,
  "concept": string,                // e.g. "product launch", "market expansion"
  "current_state": string | null,
  "targeted_state": string,
  "initial_time": "YYYY-MM-DD",
  "target_time": "YYYY-MM-DD" | null
}

### 3. risk_disclosures
[{
  "risk": string,
  "severity": "low" | "medium" | "high",
  "disclosed_early": boolean
}]

### 4. governance_signals
{
  "transparent": boolean,
  "defensive_language": boolean,
  "capital_allocation_clarity": boolean
}

### 5. tone
"confident" | "neutral" | "defensive" | "promotional"

### 6. industry_analysis
Each sub-section has a "kpis" array (industry-level metrics only) and a "factors_affecting" array (qualitative drivers/headwinds for that dimension).

KPI object schema (used in all kpis arrays below):
{
  "kpi_abbr": string,           // abbr from AVAILABLE KPIs or new_kpis
  "value": number | null,
  "statement": string,          // original statement from transcript
  "start_date": "YYYY-MM-DD" | null,  // period start; null if point-in-time snapshot
  "end_date": "YYYY-MM-DD" | null,    // period end or snapshot date
  "multiplier": number          // scale factor (e.g. 10000000 for Crores, 100000 for Lakhs, 1 for ratio/%)
}

{
  "demand": {
    "kpis": [<KPI object>],
    "factors_affecting": [string]   // e.g. macro tailwinds, regulatory push, consumer trends
  },
  "supply": {
    "kpis": [<KPI object>],
    "factors_affecting": [string]   // e.g. capacity additions, raw-material availability, imports
  },
  "operating_margins": {
    "kpis": [<KPI object>],
    "factors_affecting": [string]   // e.g. input cost pressure, pricing power, efficiency levers
  }
}

### 7. financial_strength
Company-level financial health. Each sub-section has only a "factors_affecting" array (qualitative drivers — no KPI values here, those come from the QE worker).

{
  "revenue_growth":                      { "factors_affecting": [string] },
  "profitability_and_margin_expansion":  { "factors_affecting": [string] },
  "cash_flow_generation_and_quality":    { "factors_affecting": [string] },
  "balance_sheet_strength_and_leverage": { "factors_affecting": [string] }
}

### 8. client_traction
Same KPI object schema as industry_analysis (includes start_date, end_date, multiplier).
{
  "customer_growth": {
    "kpis": [<KPI object>],
    "factors_affecting": [string]
  },
  "revenue_streams": {
    "kpis": [<KPI object>],
    "factors_affecting": [string]
  }
}

### 9. new_kpis
KPIs encountered in the transcript that were NOT in the AVAILABLE KPIs list.
Each must be fully classified per schema:

[{
  "abbr": string,                              // Short uppercase abbreviation you're assigning, e.g. "ARPU"
  "full_form": string,                         // Full name, e.g. "Average Revenue Per User"
  "kpi_type": "customer_kpis" | "industry_specific",  // customer_kpis for customer/user metrics; industry_specific for everything else
  "denomination": "rupee" | "percentage" | "ratio" | "other"
}]

### 10. confidence
"high" | "medium" | "low"

----------------------

## IMPORTANT RULES
1. Never hallucinate KPI abbrs. If unsure, add to new_kpis.
2. For industry_analysis KPIs, use only industry-level metrics (CAGR, market size, capacity utilisation, etc.). Company-specific client metrics belong in client_traction.
3. financial_strength has NO kpis arrays — only factors_affecting. Financial KPI values are handled by the QE worker separately.
4. new_kpis kpi_type must be "customer_kpis" (for user/customer metrics like ARPU, DAU) or "industry_specific" (for everything else).
5. If a section has no data, return an empty array or null as appropriate — never omit the key.
6. Return ONLY the JSON. No explanation, no markdown fences.
7. SEGMENT vs TOTAL KPIs — never use the same abbr for a segment metric and the company-wide total:
   - Use the base abbr (e.g. REV_OP, PAT, EBITDA_MARGIN) ONLY for the company-wide consolidated figure.
   - For any business-segment or division metric, prefix with SEG_<SEGMENT>_ where SEGMENT is a short uppercase label for that division (e.g. SEG_ELEC_REV_OP for Electrification revenue, SEG_PA_REV_OP for Process Automation revenue, SEG_MOT_PAT for Motion segment profit).
   - Register new SEG_* abbrs in new_kpis.
   - This applies to every KPI type — revenue, margin, profit, order book, etc.`;
}

module.exports = { transcriptExtractorPrompt };