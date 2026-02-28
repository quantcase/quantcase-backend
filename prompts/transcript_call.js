const { FINCRUX_METRICS } = require("../utils/constants");

/**
 * @param {string} transcriptText
 * @param {Array<{id: string, abbr: string, full_form: string, type: 'standalone'|'ratio', denomination?: string, numerator_abbr?: string, denominator_abbr?: string}>} existingKpis
 * @param {string} callDate - ISO date string of the earnings call e.g. "2024-11-14"
 * @param {string} [fiscalYearEnd="03-31"] - MM-DD, e.g. "03-31" for Indian FY
 */
function transcriptExtractorPrompt(transcriptText, existingKpis, callDate, fiscalYearEnd = "03-31") {
  const kpiReference = existingKpis.map(k => {
    const base = `${k.abbr} (${k.full_form}, type: ${k.type}`;
    if (k.type === 'standalone') return `${base}, denomination: ${k.denomination})`;
    if (k.type === 'ratio') return `${base}, numerator: ${k.numerator_abbr}, denominator: ${k.denominator_abbr})`;
    return `${base})`;
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
{
  "kpis": [{
    "kpi_abbr": string,             // abbr from AVAILABLE KPIs or new_kpis
    "value": number | null,
    "statement": string             // original statement from transcript
  }],
  "growth_drivers": [string],       // Array of statements describing tailwinds
  "headwinds": [string]             // Array of statements describing risks/challenges at industry level
}

### 7. new_kpis
KPIs encountered in the transcript that were NOT in the AVAILABLE KPIs list.
Each must be fully classified per schema:

[{
  "abbr": string,                   // Short uppercase abbreviation you're assigning, e.g. "ARPU"
  "full_form": string,              // Full name, e.g. "Average Revenue Per User"
  "type": "standalone" | "ratio",

  // Include only if type = "standalone":
  "denomination": "INR" | "USD" | "percentage" | "days" | "times" | "units",

  // Include only if type = "ratio":
  "numerator_abbr": string,         // abbr of numerator KPI (from AVAILABLE KPIs or other new_kpis)
  "denominator_abbr": string        // abbr of denominator KPI (from AVAILABLE KPIs or other new_kpis)
}]

### 8. confidence
"high" | "medium" | "low"

----------------------

## IMPORTANT RULES
1. Never hallucinate KPI abbrs. If unsure, add to new_kpis.
2. For industry metrics, metrics should only be related to industry like CAGR,market size, etc. Stock specific metrics should not be included.
3. new_kpis entries can reference each other in numerator_abbr/denominator_abbr as long as the referenced abbr also appears in new_kpis or AVAILABLE KPIs.
4. If a section has no data, return an empty array or null as appropriate — never omit the key.
4. Return ONLY the JSON. No explanation, no markdown fences.`;
}

module.exports = { transcriptExtractorPrompt };