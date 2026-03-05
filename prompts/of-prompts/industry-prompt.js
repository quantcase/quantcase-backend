'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'N/A';
  const note = obj.type === 'latest_value'
    ? ' (latest value)'
    : ` (${obj.type}${obj.spanYears ? ', ' + obj.spanYears + 'Y' : ''})`;
  return `${obj.value}%` + note;
}

function serializeSection(label, section) {
  if (!section) return null;
  const lines = [`  ${label}:`];
  const kpis = (section.kpis ?? []).filter(k => k.value != null);
  if (kpis.length)
    lines.push(`    KPIs: ${kpis.map(k => `${k.kpi_abbr}=${k.value} — ${k.statement ?? ''}`).join(' | ')}`);
  if (section.factors_affecting?.length)
    section.factors_affecting.forEach(f => lines.push(`    • ${f}`));
  return lines.join('\n');
}

function serializeIndustryAnalysis(row) {
  if (!row) return '(No data available)';
  const { callId, industryAnalysis: ia } = row;
  const parts = [`[Call: ${callId}]`];
  if (!ia) { parts.push('(No industry analysis)'); return parts.join('\n'); }

  const demandBlock  = serializeSection('Demand',            ia.demand);
  const supplyBlock  = serializeSection('Supply',            ia.supply);
  const marginBlock  = serializeSection('Operating Margins', ia.operating_margins);

  if (demandBlock) parts.push(demandBlock);
  if (supplyBlock) parts.push(supplyBlock);
  if (marginBlock) parts.push(marginBlock);

  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {{ callId: string, industryAnalysis: object }[]} subjectData  - up to 2
 * @param {{ callId: string, industryAnalysis: object }[]} peerData     - up to 2 peers
 * @param {{ industryOpm, industryRevCagr, industryEps, industryPe }}  computedMetrics
 */
function industryPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics) {
  const { industryOpm, industryRevCagr, industryEps, industryPe } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No subject industry analysis available)';

  const peerText = peerData.length > 0
    ? peerData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No peer industry analysis available)';

  const schemaString = JSON.stringify({ industry_overview: OFactorResponseSchema.industry_overview }, null, 2);

  const opmLine     = industryOpm?.value != null
    ? `${industryOpm.value}% (${industryOpm.sampleSize} companies, via "${industryOpm.abbrUsed}")`
    : 'N/A';
  const indEpsLine  = `${fmtCagr(industryEps)}${industryEps?.validTickerCount != null ? ` [${industryEps.validTickerCount}/${industryEps.tickerCount} tickers]` : ''}`;
  const indPeLine   = `${fmtCagr(industryPe)}${industryPe?.avgLatestPe != null ? ` (avg latest P/E: ${industryPe.avgLatestPe})` : ''}`;

  return `You are a senior equity research analyst. Produce an industry overview for the ${industry} sector.

SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}

══════════════════════════════════════════════════════════
A. PRE-COMPUTED INDUSTRY METRICS (use these directly)
══════════════════════════════════════════════════════════

  Industry Avg OPM  : ${opmLine}
  Industry Rev CAGR : ${fmtCagr(industryRevCagr)}
  Industry EPS CAGR : ${indEpsLine}
  Industry P/E CAGR : ${indPeLine}

══════════════════════════════════════════════════════════
B. INDUSTRY ANALYSIS FROM TRANSCRIPTS
══════════════════════════════════════════════════════════

### SUBJECT — ${subjectTicker}
${subjectText}

### PEERS
${peerText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

From ALL transcripts (subject + peer), identify:
  • Are the majority of managements talking about volume growth?
  • Are order books or pipelines expanding?
  • Is management guidance on volumes and capex positive or cautious?
  • What are the key demand/supply dynamics in this industry?
Populate with short and crisp points (maximum 10 words each).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { industryPrompt };
