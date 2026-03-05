'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

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
function customerTractionPrompt(subjectTicker, subjectData, computedMetrics) {
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

From the subject company's transcripts, identify:
  • Is new customer acquisition accelerating or slowing?
  • Are existing customers expanding spend (upsells, larger project scopes)?
  • Are customers deeply embedded via long contracts or multi-product use?
  • Has management referenced any alt data signals (web traffic, app engagement, customer hiring)?
Populate with short and crisp points (maximum 10 words each).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { customerTractionPrompt };
