'use strict';



const METRICS = [
  { name: 'Active Customers — latest value (CUST KPI)', type: 'computed' },
  { name: 'Customer Count CAGR', type: 'computed' },
  { name: 'Client traction from transcripts (customer growth, retention, segmentation)', type: 'qualitative' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

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


// ─── Data block builder ───────────────────────────────────────────────────────

function buildDataBlock(subjectTicker, subjectData, computedMetrics) {
  const { custLatest, custCagr } = computedMetrics;

  const _latestCallId = subjectData.length > 0 ? subjectData[subjectData.length - 1].callId : null;
  const _pm = _latestCallId && _latestCallId.match(/_FY(\d{4})_(Q\d)$/i);
  const snapshotPeriod = _pm
    ? `${_pm[2]} FY${_pm[1].slice(-2)}`
    : (custLatest?.period ?? 'latest available');

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeSubjectData(r)).join('\n\n---\n\n')
    : '(No subject client traction data available)';

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

Period context: Data above reflects ${snapshotPeriod}. Do NOT append or repeat the period label inside metric values, sublabels, or any other output fields.`;
}

// ─── Main exported prompt builder ────────────────────────────────────────────

function customerTractionPrompt(subjectTicker, subjectData, computedMetrics, customInstructions, dbTemplate, dbInstructions) {
  if (!dbTemplate)     throw new Error('[customerTractionPrompt] dbTemplate is required — configure skill "ofactor-customer-traction" in DB');
  if (!dbInstructions) throw new Error('[customerTractionPrompt] dbInstructions is required — configure skill "ofactor-customer-traction" in DB');

  const dataBlock    = buildDataBlock(subjectTicker, subjectData, computedMetrics);
  const instructions = customInstructions ?? dbInstructions;

  return dbTemplate
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', instructions);
}

module.exports = { customerTractionPrompt, buildDataBlock, METRICS };
