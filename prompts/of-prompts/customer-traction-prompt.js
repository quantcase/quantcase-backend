'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

const DEFAULT_INSTRUCTIONS = `From the subject company's KPIs and transcripts, identify:
  • Is new customer acquisition accelerating or slowing?
  • Are existing customers expanding spend (upsells, larger project scopes)?
  • Are customers deeply embedded via long contracts or multi-product use?
  • Has management referenced any alt data signals (web traffic, app engagement, customer hiring)?
Populate with short and crisp points.

When direct customer metrics (active customer count, NRR, churn) are unavailable, use proxies:
  • ORD_INF (Order Inflow) trend → proxy for new customer acquisition / demand growth
  • ORD_BOOK (Order Book / backlog) → proxy for pipeline health and revenue visibility
  • BASE_ORD_GROWTH → proxy for organic demand expansion
  • REV_OP trend (YoY or QoQ) → proxy for revenue retention / wallet-share growth
  • DOM_REV_PCT / INTL_REV_PCT mix changes → proxy for geographic customer diversification
  • Segment or division revenue splits → proxy for customer concentration (B2B industrials)
Set proxy-based metric values as a descriptive string (e.g. "Order Inflow ₹14,320 Cr (proxy)") rather than null,
and explain the proxy in the sublabel field.

Output length guidelines:
  • text.takeaway — ONE punchy sentence, 15 words max. Comma-separated key facts with one metric in parentheses. Example: "No concentration risk, distribution depth intact"
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

function serializeSubjectData(row) {
  if (!row) return '(No data available)';
  const { callId, kpis = [], clientTraction: ct } = row;
  const parts = [`[Call: ${callId}]`];

  if (kpis.length > 0) {
    parts.push('\nCurrent Quarter KPIs (total revenue + industry-specific + segment):');
    kpis.forEach(k => parts.push(`  ${k.kpi_abbr.padEnd(24)} = ${k.value}`));
  }

  const custFactors = ct?.customer_growth?.factors_affecting ?? [];
  const revFactors  = ct?.revenue_streams?.factors_affecting  ?? [];

  if (custFactors.length > 0) {
    parts.push('\nCustomer Growth — Factors Affecting:');
    custFactors.forEach(f => parts.push(`  • ${f}`));
  }

  if (revFactors.length > 0) {
    parts.push('\nRevenue Streams — Factors Affecting:');
    revFactors.forEach(f => parts.push(`  • ${f}`));
  }

  // Pass through retention/segmentation qualitative context if present
  if (ct?.retention && Object.keys(ct.retention).length > 0) {
    parts.push('\nRetention Context:');
    parts.push(JSON.stringify(ct.retention, null, 2));
  }

  if (ct?.segmentation && Object.keys(ct.segmentation).length > 0) {
    parts.push('\nSegmentation Context:');
    parts.push(JSON.stringify(ct.segmentation, null, 2));
  }

  if (!custFactors.length && !revFactors.length) {
    parts.push('(No data available)');
  }

  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {{ callId, clientTraction }[]} subjectData  - subject only, no peers
 * @param {{ custLatest, custCagr }} computedMetrics
 */
function customerTractionPrompt(subjectTicker, subjectData, computedMetrics, customInstructions) {
  const { custLatest, custCagr } = computedMetrics;

  // Determine analysis period from the latest subject call
  const _latestCallId = subjectData.length > 0 ? subjectData[subjectData.length - 1].callId : null;
  const _pm = _latestCallId && _latestCallId.match(/_FY(\d{4})_(Q\d)$/i);
  const snapshotPeriod = _pm
    ? `${_pm[2]} FY${_pm[1].slice(-2)}`
    : (custLatest?.period ?? 'latest available');

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeSubjectData(r)).join('\n\n---\n\n')
    : '(No subject client traction data available)';

  const schemaString = JSON.stringify({ customer_traction: OFactorResponseSchema.customer_traction }, null, 2);

  return `You are a senior equity research analyst. Analyze client/customer traction for ${subjectTicker}.

SUBJECT COMPANY : ${subjectTicker}
ANALYSIS PERIOD : ${snapshotPeriod}

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

Period context: Data above reflects ${snapshotPeriod}. Do NOT append or repeat the period label inside metric values, sublabels, or any other output fields.

${customInstructions ?? DEFAULT_INSTRUCTIONS}

Populate the "final_scoring" field INSIDE the customer_traction JSON object (same level as "metrics"). Award 1 point per check, max 10:
  1. Customer count growing YoY → text.customer_growth.metrics.current_base trend
  2. Churn rate ≤ 5% or declining → metrics.churn_rate
  3. Net revenue retention ≥ 100% → metrics.net_retention
  4. New customer additions positive → text.customer_growth.metrics.new_adds
  5. Pipeline / order book growing → text.customer_growth.acquisition_dynamics
  6. Long-term contracts or sticky revenue model → text.retention.product_stickiness
  7. Revenue per customer (avg contract value) increasing → metrics.avg_contract_value
  8. Customer concentration manageable (top-10 < 30%) → metrics.top_10_concentration
  9. Cross-sell or upsell happening → text.retention.expansion_drivers
  10. Management provides specific customer metrics in transcripts → presence of non-null customer_growth metrics
  status: score >= 7 → "HIGH TRACTION" (green), score 5–6 → "MODERATE TRACTION" (yellow), score < 5 → "LOW TRACTION" (red).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { customerTractionPrompt, DEFAULT_INSTRUCTIONS, METRICS };
