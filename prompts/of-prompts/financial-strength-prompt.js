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
  return `${obj.value} (${obj.abbrUsed ?? ''}, ${obj.period ?? 'latest'})`;
}

function fmtRatio(obj) {
  if (!obj || obj.value == null) return 'N/A';
  return `${obj.value}x`;
}

function serializeFinancialStrength(row) {
  if (!row) return '(No data available)';
  const { callId, financialStrength: fs } = row;
  const parts = [`[Call: ${callId}]`];
  if (!fs) { parts.push('(No financial strength data)'); return parts.join('\n'); }
  parts.push(JSON.stringify(fs, null, 2));
  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {{ callId, financialStrength }[]} subjectData  - subject only, no peers
 * @param {{ stockEps, stockPe, stockRevCagr, roce, fcf, deRatio, netDebtEbitda, ic, cr, opm }} computedMetrics
 */
function financialStrengthPrompt(subjectTicker, subjectData, computedMetrics) {
  const { stockEps, stockPe, stockRevCagr, roce, fcf, deRatio, netDebtEbitda, ic, cr, opm } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeFinancialStrength(r)).join('\n\n---\n\n')
    : '(No subject financial strength data available)';

  const schemaString = JSON.stringify({ financial_strength: OFactorResponseSchema.financial_strength }, null, 2);

  return `You are a senior equity research analyst. Assess the financial strength of ${subjectTicker}.

SUBJECT COMPANY : ${subjectTicker}

══════════════════════════════════════════════════════════
A. PRE-COMPUTED FINANCIAL METRICS (use these directly)
══════════════════════════════════════════════════════════

  Growth & Earnings
    EPS CAGR      : ${fmtCagr(stockEps)}${stockEps?.firstValue != null ? ` (${stockEps.firstValue} → ${stockEps.latestValue} over ${stockEps.spanYears}Y, ${stockEps.periodsUsed} quarters)` : ''}
    Revenue CAGR  : ${fmtCagr(stockRevCagr)}
    P/E CAGR      : ${fmtCagr(stockPe)}${stockPe?.latestPe != null ? ` (latest P/E: ${stockPe.latestPe}, avg: ${stockPe.avgPe})` : ''}

  Profitability
    ROCE (latest) : ${fmtKpi(roce)}
    OPM (latest)  : ${fmtKpi(opm)}

  Cash Flow
    FCF (latest)  : ${fmtKpi(fcf)}

  Balance Sheet
    Net Debt/EBITDA : ${fmtRatio(netDebtEbitda)}
    Debt/Equity     : ${fmtRatio(deRatio)}
    Interest Cov    : ${fmtRatio(ic)}
    Current Ratio   : ${fmtRatio(cr)}

══════════════════════════════════════════════════════════
B. FINANCIAL STRENGTH FROM TRANSCRIPTS (subject only)
══════════════════════════════════════════════════════════

${subjectText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

Using the pre-computed metrics above and transcript data, assess:
  • Revenue growth trajectory — volume/mix driven or purely price-led?
  • Margin expansion — is management confident about sustaining margins?
  • FCF conversion quality and capital deployment discipline
  • Balance sheet strength — debt targets, capex ROI, shareholder returns
Populate with short and crisp points (maximum 10 words each).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { financialStrengthPrompt };
