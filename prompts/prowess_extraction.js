'use strict';

/**
 * Prompt for the prowess-extraction skill.
 *
 * The LLM receives a compact table (row_id, metric, value, period) and returns
 * only impact + severity per row_id. All other signal fields are assembled from
 * the original DB rows in the worker — the LLM never re-echoes known data.
 */
const PROMPT_TEMPLATE = `You are a financial signal analyst with deep knowledge of Indian listed companies across all sectors. You will be given a compact table of KPI rows from audited financial statements. Your only job is to assign an **impact** and **severity** to each row based on observable trends across the provided periods.

{{DATA_BLOCK}}

----------------------

## INSTRUCTIONS

### Industry context (apply sector-specific materiality norms)
Use the INDUSTRY field above to calibrate what counts as "high impact" and "critical severity". Different industries have different key value drivers:
- **Banks / NBFCs / Financial Services**: NIM, NPA/GNPA, PCR, CAR/CRAR, ROA, ROE, credit growth, deposit growth, and cost-of-funds are high impact; fee income and opex ratios are medium. A 20 bps NIM compression is critical; the same move in a manufacturer's other income is not.
- **Auto & Auto Components**: Revenue growth, EBITDA margin, raw-material cost ratios, and working capital (inventory days, debtor days) are high impact. Volume mix and realization per unit matter more than for non-cyclical industries.
- **IT / Software Services**: Revenue growth (constant-currency), EBIT margin, attrition, deal TCV/wins, utilization, and headcount are high impact. DSO and subcontracting cost are medium.
- **Consumer / FMCG**: Volume growth, gross margin, A&P spend, and distribution metrics are high impact. Price mix decomposition matters; small margin swings on large volumes are critical.
- **Pharma / Healthcare**: R&D spend, domestic formulation growth, US generics revenue and pricing pressure, ANDA pipeline, and working capital are high impact.
- **Cement / Metals / Commodities**: Realization per unit, volume, energy/fuel cost, and capacity utilization are high impact. For metals, EBITDA per tonne is the primary metric.
- **Real Estate / Infrastructure**: Pre-sales, collections, net debt, and order book are high impact. Revenue recognition lags cash flows so cash metrics dominate.
- **Telecom**: ARPU, subscriber additions, data traffic, capex intensity, and leverage are high impact.
- **Capital Goods / Engineering**: Order inflows, order backlog, execution rate, and working capital cycle are high impact.
- **Diversified / Conglomerates**: Assess each segment's metrics by the segment's own industry norms; consolidated debt and ROE are always high impact.

If the company's industry does not match any category above, apply general investment materiality norms.

### Impact rules (assess materiality for investment decision-making, weighted by industry norms above)
- "high"   — primary value-driver metrics for this industry (see above), key P&L lines (revenue, PAT, EBITDA/NIM/ARPU as applicable), total debt/equity, major cashflow figures, return ratios
- "medium" — secondary P&L/balance sheet lines, EPS, working capital items, segment-level breakdowns
- "low"    — minor line items, supplementary or disclosure-only figures

### Severity rules (assess signal strength based on trend data in the table, calibrated to industry norms)
Compare each metric against the prior available period (QoQ for quarterly rows, YoY for annual rows). Use tighter thresholds for metrics that are primary value drivers in the company's industry:
- "critical"      — >20% deterioration in a key metric (or a smaller move that is abnormal for this industry, e.g. 20 bps NIM compression for a bank)
- "high"          — 10–20% deterioration
- "medium"        — 5–10% deterioration
- "low"           — <5% deterioration or minor miss
- "informational" — improvement, stable, or no prior period available for comparison

----------------------

## OUTPUT FORMAT

Return ONLY a valid JSON object:

{
  "enrichments": [
    {
      "row_id": number,
      "impact": "high" | "medium" | "low",
      "severity": "critical" | "high" | "medium" | "low" | "informational"
    }
  ]
}

Return only the JSON object. No explanation, no markdown fences.`;

// ─── Section builder ──────────────────────────────────────────────────────────

const STATEMENT_TO_FAMILY = {
  pnl:           'profitability',
  cashflow:      'growth',
  balance_sheet: 'capital',
};

/**
 * Format rows as a compact pipe-delimited table for LLM input.
 * Columns: row_id | metric | value | period (human-readable summary)
 * row_id is the index in the combined allRows array so we can look up the original.
 */
function formatCompactTable(rows, startId = 0) {
  if (!rows.length) return '(no data)';
  const header = '| row_id | metric    | value         | period                        |';
  const sep    = '|--------|-----------|---------------|-------------------------------|';
  const lines  = rows.map((r, i) => {
    const id     = String(startId + i).padEnd(6);
    const metric = String(r.kpi_abbr  ?? '').padEnd(9);
    const value  = String(r.raw_value ?? '').padEnd(13);
    // Compact period descriptor: FY + quarter + period_type
    const period = `${r.fiscal_year ?? ''} ${r.quarter ?? ''} ${r.period_type ?? ''}`.trim().padEnd(29);
    return `| ${id} | ${metric} | ${value} | ${period} |`;
  });
  return [header, sep, ...lines].join('\n');
}

/**
 * Build the compact DATA_BLOCK injected into the prompt.
 * annualRows and quarterlyRows are kept separate for context clarity,
 * but row_ids are globally sequential so the LLM can reference them unambiguously.
 */
function buildDataBlock(annualRows, quarterlyRows, quarter, fiscal_year, company, industry = null) {
  const annualTable    = formatCompactTable(annualRows, 0);
  const quarterlyTable = formatCompactTable(quarterlyRows, annualRows.length);
  return `COMPANY: ${company}
INDUSTRY: ${industry || 'Unknown'}
CURRENT QUARTER: ${quarter}
CURRENT FISCAL YEAR: ${fiscal_year}

----------------------

## SECTION 1: ANNUAL FINANCIALS (Audited, multi-year)

${annualTable}

----------------------

## SECTION 2: CURRENT FISCAL YEAR QUARTERLY FINANCIALS

${quarterlyTable}`;
}

/**
 * Build the full prowess extraction prompt.
 */
function prowessExtractionPrompt(annualRows, quarterlyRows, quarter, fiscal_year, company, dbTemplate = null, industry = null) {
  const dataBlock = buildDataBlock(annualRows, quarterlyRows, quarter, fiscal_year, company, industry);
  const template  = dbTemplate ?? PROMPT_TEMPLATE;
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

/**
 * Assemble a full signal object from a DB row + LLM enrichment.
 * The LLM only provides impact and severity; everything else comes from the row.
 */
function assembleSignal(row, enrichment, sigBase) {
  return {
    ...sigBase,
    signal_type:   'kpi',
    metric:        row.kpi_abbr,
    metric_family: STATEMENT_TO_FAMILY[row.statement] ?? 'profitability',
    value:         row.raw_value !== null && row.raw_value !== undefined ? parseFloat(row.raw_value) : null,
    raw_value:     row.raw_value !== null ? String(row.raw_value) : null,
    unit:          row.unit          ?? null,
    multiplier:    row.multiplier    ?? 1,
    start_date:    row.start_date    ?? null,
    end_date:      row.end_date      ?? null,
    period_type:   row.period_type   ?? null,
    statement:     row.statement     ?? null,
    impact:        enrichment?.impact   ?? null,
    severity:      enrichment?.severity ?? null,
  };
}

module.exports = {
  prowessExtractionPrompt,
  buildDataBlock,
  formatCompactTable,
  assembleSignal,
  STATEMENT_TO_FAMILY,
  PROMPT_TEMPLATE,
};
