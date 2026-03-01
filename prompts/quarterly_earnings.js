/**
 * @param {Array<{id: string, abbr: string, full_form: string, type: 'standalone'|'ratio', denomination?: string, numerator_abbr?: string, denominator_abbr?: string}>} kpis
 * @param {string} quarter - e.g. "Q2"
 * @param {string} fiscal_year - e.g. "FY2025"
 * @param {string} callDate - ISO date string e.g. "2024-11-14"
 */
function quarterlyEarningsPrompt(kpis, quarter, fiscal_year, callDate) {
  const kpiReference = kpis.map(k => {
    const base = `${k.abbr} (${k.full_form}, type: ${k.type}`;
    if (k.type === 'standalone') return `${base}, denomination: ${k.denomination})`;
    if (k.type === 'ratio') return `${base}, numerator: ${k.numerator_abbr}, denominator: ${k.denominator_abbr})`;
    return `${base})`;
  }).join('\n  ');

  return `You are a financial data extraction specialist. Your task is to extract KPI values for a specific quarter from the quarterly earnings document provided above.

QUARTER: ${quarter}
FISCAL YEAR: ${fiscal_year}
CALL DATE: ${callDate}

----------------------

## AVAILABLE KPIs
When referencing any KPI in your output, always use its exact \`abbr\` from this list:

  ${kpiReference}

If you encounter a financial metric NOT in the above list, do NOT invent an abbr that conflicts with the list. Instead, collect it in the \`new_kpis\` array (schema defined below) and reference it by the abbr you assign there.

----------------------

## EXTRACTION RULES
1. Extract latest values ONLY 
2. Values must be decimal numbers only — no units, no currency symbols, no commas, no percentage signs. E.g. revenue of ₹1,234.56 Cr → 1234.56.
3. Never hallucinate KPI abbrs. If unsure whether a metric matches an existing abbr, add it to new_kpis.

----------------------

## OUTPUT SCHEMA

Return ONLY a valid JSON object with the following two top-level keys:

### 1. kpis
[{
  "kpi_abbr": string,     
  "value": number | null  // Current quarter absolute value only
}]

### 2. new_kpis
KPIs encountered in the document that were NOT in the AVAILABLE KPIs list.
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

----------------------

## IMPORTANT RULES
1. kpis include both new and existing KPIs. If existing, match exact abbr from AVAILABLE KPIs. If new, use the abbr you assign and populate same abbr in new_kpis
2. new_kpis entries can reference each other in numerator_abbr/denominator_abbr as long as the referenced abbr also appears in new_kpis or AVAILABLE KPIs.
4. Return ONLY the JSON. No explanation, no markdown fences.`;
}

module.exports = { quarterlyEarningsPrompt };
