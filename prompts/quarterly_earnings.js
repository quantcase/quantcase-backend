'use strict';

/**
 * PROMPT_TEMPLATE — static instructional portion stored in the DB (skills.prompt_template).
 * Dynamic runtime data is injected at {{DATA_BLOCK}} by the worker.
 *
 * To edit the prompt without a code deploy: update the `prompt_template` column on the
 * `qe-extraction` skill row in the database.
 */
const PROMPT_TEMPLATE = `You are a financial data extraction specialist. Extract all KPI signals from the quarterly earnings document provided and return them as a flat signal array.

{{DATA_BLOCK}}

----------------------

## EXTRACTION RULES

### Period selection (CRITICAL)
Indian quarterly reports show multiple date columns in the same table. Follow these rules strictly:

- **Balance Sheet items**: Always point-in-time. Extract the closing balance as of the most recent date. Set start_date to null; end_date is the snapshot date. period_type: "snapshot".
- **P&L and Cash Flow items**: Prefer the standalone quarterly column (the column covering only the current 3-month quarter). If a standalone quarterly column is not present, extract the longest available period. period_type: "quarterly" | "half_yearly" | "annual" as appropriate.

### Per-KPI fields
For every extracted KPI resolve and output:
- **start_date**: ISO date (YYYY-MM-DD) — first day of the period. null for balance sheet items.
- **end_date**: ISO date (YYYY-MM-DD) — last day of the period, or snapshot date for balance sheet.
- **multiplier**: integer — factor to convert the reported value to absolute base unit:
  - Values in Lakhs → 100000
  - Values in Crores → 10000000
  - Values in absolute rupees, unitless counts, EPS (₹/share) → 1
  - Percentage / ratio → 1
  Note: multiplier can differ across KPIs in the same document.
- **value**: plain number — no units, currency symbols, commas, or percentage signs. Decimals allowed. E.g. ₹1,234.56 Cr → 1234.56.

### General rules
1. Match each KPI using its label or any of its listed aliases.
2. If a KPI is not explicitly stated in the document, omit it from the output (do not emit null-value signals).
3. Do NOT calculate, derive, or infer any value — only extract explicitly stated figures.

----------------------

## IMPACT & SEVERITY RULES (assign to EVERY signal)

Assess each signal in the context of the company's reported quarter:

**impact** — materiality for investment decision-making:
- "high"   — key P&L line (revenue, PAT, EBITDA), major balance sheet item (total debt, equity), or large FCF figure
- "medium" — secondary P&L/balance sheet line or ratio
- "low"    — minor line item or supplementary figure

**severity** — for negative signals (miss vs prior quarter/year), use:
- "critical"      — >20% deterioration in a key metric
- "high"          — 10–20% deterioration
- "medium"        — 5–10% deterioration
- "low"           — <5% deterioration or minor miss
- "informational" — improvement or neutral (use for all positive/neutral signals)

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object with exactly one top-level key:

{
  "extracted_signals": [
    {
      "signal_type": "kpi",
      "metric": string,              // KPI abbr from the list below
      "metric_family": string,       // "profitability" | "growth" | "capital" | "industry"
      "value": number,               // extracted numeric value (absolute base unit)
      "raw_value": string,           // value as it appears in the document (e.g. "1234.56")
      "unit": string | null,         // "Cr" | "%" | "x" | "₹" | null
      "multiplier": number,          // integer scale factor
      "start_date": string | null,   // YYYY-MM-DD
      "end_date": string,            // YYYY-MM-DD (required)
      "period_type": string,         // "snapshot" | "quarterly" | "half_yearly" | "annual"
      "statement": null,
      "impact": "high" | "medium" | "low",
      "severity": "critical" | "high" | "medium" | "low" | "informational",
      "time_horizon": null,
      "esg_tag": null,
      "risk_tag": null,
      "milestone_category": null
    }
  ]
}

Return only the JSON object. No explanation, no markdown fences.`;

/**
 * Assign metric_family based on KPI section.
 * The QE config groups KPIs into balance_sheet, pnl, cashflow — map to metric_family.
 */
const SECTION_TO_FAMILY = {
  balance_sheet: 'capital',
  pnl:           'profitability',
  cashflow:      'growth',
};

/**
 * Assemble the runtime data block (quarter metadata + KPI reference list).
 *
 * @param {Array<{abbr, label, aliases, section}>} kpis  — section field added by worker
 * @param {string} quarter
 * @param {string} fiscal_year
 * @param {string} callDate
 * @returns {string}
 */
function buildDataBlock(kpis, quarter, fiscal_year, callDate) {
  const kpiReference = kpis.map(k => {
    const aliases = k.aliases?.length ? ` (also: ${k.aliases.join(', ')})` : '';
    const family  = SECTION_TO_FAMILY[k.section] ?? 'profitability';
    return `- ${k.abbr} [metric_family: ${family}]: ${k.label}${aliases}`;
  }).join('\n');

  return `QUARTER: ${quarter}
FISCAL YEAR: ${fiscal_year}
CALL DATE: ${callDate}

----------------------

## KPIs TO EXTRACT

${kpiReference}`;
}

/**
 * Build the full quarterly earnings prompt.
 *
 * @param {Array<{abbr, label, aliases, section}>} kpis
 * @param {string} quarter
 * @param {string} fiscal_year
 * @param {string} callDate
 * @param {string|null} [dbTemplate=null]
 * @returns {string}
 */
function quarterlyEarningsPrompt(kpis, quarter, fiscal_year, callDate, dbTemplate = null) {
  const dataBlock = buildDataBlock(kpis, quarter, fiscal_year, callDate);
  const template  = dbTemplate ?? PROMPT_TEMPLATE;
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { quarterlyEarningsPrompt, buildDataBlock, PROMPT_TEMPLATE, SECTION_TO_FAMILY };
