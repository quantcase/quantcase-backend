'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

const DEFAULT_INSTRUCTIONS = `From the subject company's transcripts, identify:
  • Is new customer acquisition accelerating or slowing?
  • Are existing customers expanding spend (upsells, larger project scopes)?
  • Are customers deeply embedded via long contracts or multi-product use?
  • Has management referenced any alt data signals (web traffic, app engagement, customer hiring)?
Populate with short and crisp points.

Output length guidelines:
  • text.takeaway — 1 concise sentence
  • text.key_takeaway — 10 words max
  • text.retention.expansion_drivers, .product_stickiness — 10 words max per item
  • text.segmentation.growth_strategy, .revenue_quality — 10 words max per item
  • text.customer_growth.acquisition_dynamics — 10 words max per item
  • text.alt_data_signals[].insight — 10 words max each`;

const METRICS = [
  { name: 'Active Customers — latest value (CUST KPI)', type: 'computed' },
  { name: 'Customer Count CAGR', type: 'computed' },
  { name: 'Client traction from transcripts (customer growth, retention, segmentation)', type: 'qualitative' },
];

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'N/A';
  const note = obj.type === 'latest_value'
    ? ' (latest value)'
    : ` (${obj.type}${obj.spanYears ? ', ' + obj.spanYears + 'Y' : ''})`;
  return `${obj.value}%` + note;
}

function fmtKpi(obj) {
  if (!obj || obj.value == null) return 'N/A';
  return `${obj.value.toLocaleString('en-IN')} (${obj.abbrUsed ?? ''}, ${obj.period ?? 'latest'})`;
}

function serializeClientTraction(row) {
  if (!row) return '(No data available)';
  const { callId, clientTraction: ct } = row;
  const parts = [`[Call: ${callId}]`];
  if (!ct) { parts.push('(No client traction data)'); return parts.join('\n'); }
  parts.push(JSON.stringify(ct, null, 2));
  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {{ callId, clientTraction }[]} subjectData  - subject only, no peers
 * @param {{ custLatest, custCagr }} computedMetrics
 */
function customerTractionPrompt(subjectTicker, subjectData, computedMetrics, customInstructions) {
  const { custLatest, custCagr } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeClientTraction(r)).join('\n\n---\n\n')
    : '(No subject client traction data available)';

  const schemaString = JSON.stringify({ customer_traction: OFactorResponseSchema.customer_traction }, null, 2);

  return `You are a senior equity research analyst. Analyze client/customer traction for ${subjectTicker}.

SUBJECT COMPANY : ${subjectTicker}

══════════════════════════════════════════════════════════
A. PRE-COMPUTED CUSTOMER METRICS (use these directly)
══════════════════════════════════════════════════════════

  Active Customers (latest) : ${fmtKpi(custLatest)}
  Customer Count CAGR       : ${fmtCagr(custCagr)}

══════════════════════════════════════════════════════════
B. CLIENT TRACTION FROM TRANSCRIPTS (subject only)
══════════════════════════════════════════════════════════

${subjectText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

${customInstructions ?? DEFAULT_INSTRUCTIONS}

Metric-specific instructions for when data is unavailable:
  • metrics.net_retention: If NRR is not formally disclosed (e.g. for banks/MFI), set value to null and sublabel to a contextual proxy note (e.g. "Not formally disclosed; NII YoY as proxy" or "Portfolio AUM growth as retention proxy").
  • metrics.top_10_concentration: For retail-focused companies with granular books (MFI, consumer banking), set value to null and sublabel to "Retail granular book; not separately disclosed". For B2B companies, infer from transcripts if possible.
  • metrics.avg_contract_value: If ticket sizes or AUM per customer are not separately disclosed, set value to null and sublabel to "Ticket sizes not separately disclosed in transcripts".
  • text.retention.metrics.net_revenue_retention: Same guidance as metrics.net_retention above.
  • text.retention.metrics.gross_revenue_retention: If not explicitly reported, set value to null and sublabel to "Not explicitly reported in transcripts".

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { customerTractionPrompt, DEFAULT_INSTRUCTIONS, METRICS };
