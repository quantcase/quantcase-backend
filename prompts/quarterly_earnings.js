/**
 * @param {Array<{abbr: string, label: string, aliases: string[]}>} kpis
 * @param {string} quarter - e.g. "Q2"
 * @param {string} fiscal_year - e.g. "FY2025"
 * @param {string} callDate - ISO date string e.g. "2024-11-14"
 */
function quarterlyEarningsPrompt(kpis, quarter, fiscal_year, callDate) {
  const kpiReference = kpis.map(k =>
    `- ${k.abbr}: ${k.label}${k.aliases.length ? ` (also: ${k.aliases.join(', ')})` : ''}`
  ).join('\n');

  return `You are a financial data extraction specialist. Extract KPI values from the quarterly earnings document provided.

QUARTER: ${quarter}
FISCAL YEAR: ${fiscal_year}
CALL DATE: ${callDate}

----------------------

## KPIs TO EXTRACT

${kpiReference}

----------------------

## EXTRACTION RULES

### Period selection (CRITICAL)
Indian quarterly reports show multiple date columns in the same table. Follow these rules strictly:

- **Balance Sheet items**: Always point-in-time. Extract the closing balance as of the most recent date. Set start_date to null; end_date is the snapshot date.
- **P&L and Cash Flow items**: Prefer the standalone quarterly column (the column covering only the current 3-month quarter). If a standalone quarterly column is not present for a given item (common for cash flow statements which are often published only on a half-year or annual basis), extract the longest available period instead. The start_date and end_date you output will make the period unambiguous — do not approximate.

### Per-KPI fields
For every extracted KPI, resolve and output these fields:
- **start_date**: ISO date (YYYY-MM-DD) — first day of the period the value covers. null for balance sheet items.
- **end_date**: ISO date (YYYY-MM-DD) — last day of the period, or snapshot date for balance sheet.
- **multiplier**: integer — factor to convert the reported value to its absolute base unit. Examples:
  - Values in Lakhs → 100000
  - Values in Crores → 10000000
  - Values in absolute rupees or unitless counts → 1
  - Percentage / ratio values → 1
  - EPS (₹ per share) → 1
  Note: multiplier can differ across KPIs in the same document (e.g. EPS is ₹/share while revenue is in Lakhs).

### General rules
1. Match each KPI using its label or any of its listed aliases.
2. Values must be plain numbers — no units, currency symbols, commas, or percentage signs. Decimals allowed. E.g. ₹1,234.56 Cr → 1234.56.
3. If a KPI is not explicitly stated in the document, return null for all its fields.
4. Do NOT calculate, derive, or infer any value.

----------------------

## OUTPUT FORMAT

Return a structured JSON object with keys: balance_sheet, pnl, cashflow.
Each KPI field: { "abbr": "<KPI_ABBR>", "value": <number|null>, "start_date": <"YYYY-MM-DD"|null>, "end_date": <"YYYY-MM-DD"|null>, "multiplier": <number|null> }

Return only the JSON object. No explanation, no markdown fences.`;
}

module.exports = { quarterlyEarningsPrompt };
