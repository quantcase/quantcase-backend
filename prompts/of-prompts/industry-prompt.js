'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

/** Latest non-null value from a time-series array, or null. */
function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

/**
 * Render a KPI time-series as "period: value" pairs for the last N quarters.
 * Returns 'N/A' when no data is available.
 */
function _sparkline(series, n = 4) {
  if (!Array.isArray(series)) return 'N/A';
  const rows = series.filter(s => s.value != null).slice(-n);
  if (!rows.length) return 'N/A';
  return rows.map(r => `${r.period}: ${r.value}`).join('  |  ');
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

  const demandBlock = serializeSection('Demand',            ia.demand);
  const supplyBlock = serializeSection('Supply',            ia.supply);
  const marginBlock = serializeSection('Operating Margins', ia.operating_margins);

  if (demandBlock) parts.push(demandBlock);
  if (supplyBlock) parts.push(supplyBlock);
  if (marginBlock) parts.push(marginBlock);

  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {{ callId: string, industryAnalysis: object }[]} subjectData
 * @param {{ callId: string, industryAnalysis: object }[]} peerData
 * @param {{ rawBatch: Record<string, Array>, derivedBatch: Record<string, Array> }} computedMetrics
 */
function industryPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics) {
  const { rawBatch, derivedBatch } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No subject industry analysis available)';

  const peerText = peerData.length > 0
    ? peerData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No peer industry analysis available)';

  const schemaString = JSON.stringify({ industry_overview: OFactorResponseSchema.industry_overview }, null, 2);

  // Latest point-in-time values
  const fmt = v => v != null ? v : 'N/A';

  const revOp      = _latest(rawBatch?.REV_OP);
  const totalInc   = _latest(rawBatch?.TOTAL_INCOME);
  const pat        = _latest(rawBatch?.PAT);
  const pbt        = _latest(rawBatch?.PBT);
  const finCost    = _latest(rawBatch?.FIN_COST);
  const totalAssets= _latest(rawBatch?.TOTAL_ASSETS);
  const currLiab   = _latest(rawBatch?.CURR_LIAB);

  const ebit       = _latest(derivedBatch?.EBIT);
  const roce       = _latest(derivedBatch?.ROCE);
  const roa        = _latest(derivedBatch?.ROA);
  const roe        = _latest(derivedBatch?.ROE);
  const capex      = _latest(derivedBatch?.CAPEX);
  const fcf        = _latest(derivedBatch?.FCF);

  return `You are a senior equity research analyst. Produce an industry overview for the ${industry} sector.

SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}

══════════════════════════════════════════════════════════
A. SUBJECT COMPANY FINANCIAL SNAPSHOT (latest quarter)
══════════════════════════════════════════════════════════

  Revenue from Operations : ${fmt(revOp)}
  Total Income            : ${fmt(totalInc)}
  EBIT                    : ${fmt(ebit)}
  PBT                     : ${fmt(pbt)}
  PAT                     : ${fmt(pat)}
  Finance Costs           : ${fmt(finCost)}
  Total Assets            : ${fmt(totalAssets)}
  Current Liabilities     : ${fmt(currLiab)}
  ROCE                    : ${roce != null ? roce + '%' : 'N/A'}
  ROA                     : ${roa  != null ? roa  + '%' : 'N/A'}
  ROE                     : ${roe  != null ? roe  + '%' : 'N/A'}
  CAPEX                   : ${fmt(capex)}
  FCF                     : ${fmt(fcf)}

── Revenue trend (last 4 quarters) ──
  ${_sparkline(rawBatch?.REV_OP)}

── PAT trend (last 4 quarters) ──
  ${_sparkline(rawBatch?.PAT)}

── EBIT trend (last 4 quarters) ──
  ${_sparkline(derivedBatch?.EBIT)}

── ROCE trend (last 4 quarters) ──
  ${_sparkline(derivedBatch?.ROCE)}

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
