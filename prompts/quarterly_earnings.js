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

  return `You are a financial data extraction specialist. Extract KPI values for a specific quarter from the quarterly earnings document provided.

QUARTER: ${quarter}
FISCAL YEAR: ${fiscal_year}
CALL DATE: ${callDate}

----------------------

## KPIs TO EXTRACT

${kpiReference}

----------------------

## EXTRACTION RULES
1. Extract values for the LATEST reported period in the document. The document may contain multiple periods (e.g. current quarter, previous quarter, full year) — always pick the most recent date column.
2. Match each KPI using its label or any of its listed aliases.
3. Values must be plain numbers — no units, currency symbols, commas, or percentage signs. Decimals are allowed. E.g. ₹1,234.56 Cr → 1234.56.
4. If a KPI value is NOT explicitly stated in the document, return null.
5. Do NOT calculate, derive, or infer any value. If it is not directly reported, return null.

----------------------

## OUTPUT FORMAT

Return a structured JSON object with the following top-level keys:
- **meta**: company name, report period (yyyy-mm-dd — use the latest period end date), report type (Standalone/Consolidated), currency, unit, multiplier
- **balance_sheet**: assets, liabilities, equity — each KPI field as { "abbr": "<KPI_ABBR>", "value": <number> | null }
- **pnl**: revenue, cogs, operating_expenses, profit_lines — same format
- **cashflow**: CFO, CFI, CFF and net change — same format

Return only the JSON object. No explanation, no markdown fences.`;
}

module.exports = { quarterlyEarningsPrompt };
