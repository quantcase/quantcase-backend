'use strict';

const METRICS = [
  { name: 'Revenue from Operations (REV_OP)', type: 'raw_kpi', trend: 'last 4 Q4s' },
  { name: 'Total Income (TOTAL_INCOME)', type: 'raw_kpi' },
  { name: 'Cost of Materials (COST_MAT)', type: 'raw_kpi' },
  { name: 'Purchases of Stock-in-Trade (PURCH_STOCK)', type: 'raw_kpi' },
  { name: 'Inventory Change (INV_CHG)', type: 'raw_kpi' },
  { name: 'Employee Expenses (EMP_EXP)', type: 'raw_kpi' },
  { name: 'Other Expenses (OTH_EXP)', type: 'raw_kpi' },
  { name: 'Finance Costs (FIN_COST)', type: 'raw_kpi' },
  { name: 'Depreciation & Amortisation (DEP_AMORT)', type: 'raw_kpi' },
  { name: 'PBT', type: 'raw_kpi' },
  { name: 'PAT', type: 'raw_kpi', trend: 'last 4 Q4s' },
  { name: 'Total Assets (TOTAL_ASSETS)', type: 'raw_kpi' },
  { name: 'Current Liabilities (CURR_LIAB)', type: 'raw_kpi' },
  { name: 'EBIT', type: 'derived_kpi', trend: 'last 4 Q4s' },
  { name: 'ROCE', type: 'derived_kpi', trend: 'last 4 Q4s' },
  { name: 'ROA', type: 'derived_kpi' },
  { name: 'ROE', type: 'derived_kpi' },
  { name: 'CAPEX', type: 'derived_kpi' },
  { name: 'FCF', type: 'derived_kpi' },
  { name: 'Subject industry analysis (demand / supply / margins)', type: 'qualitative' },
  { name: 'Peer industry analysis (demand / supply / margins)', type: 'qualitative' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

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

// ─── Data block builder ───────────────────────────────────────────────────────

/**
 * Assemble the runtime data block injected at {{DATA_BLOCK}}.
 */
function buildDataBlock(subjectTicker, industry, subjectData, peerData, computedMetrics) {
  const { rawBatch, derivedBatch, derivedBatchAll = {}, bfsi = false } = computedMetrics;

  const _latestAny = (q4Series, allSeries) => _latest(q4Series) ?? _latest(allSeries);
  const _sparklineWithFallback = (q4Series, allSeries, n = 4) => {
    const hasQ4Data = Array.isArray(q4Series) && q4Series.some(s => s.value != null);
    return _sparkline(hasQ4Data ? q4Series : allSeries, n);
  };

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No subject industry analysis available)';

  const peerText = peerData.length > 0
    ? peerData.map(r => serializeIndustryAnalysis(r)).join('\n\n---\n\n')
    : '(No peer industry analysis available)';

  const fmt = v => v != null ? v : 'N/A';

  const _revSeries = rawBatch?.REV_OP;
  const _snapshotEntry = Array.isArray(_revSeries)
    ? (_revSeries.filter(s => s.value != null).at(-1) ?? null)
    : null;
  const snapshotPeriod = (_snapshotEntry?.quarter && _snapshotEntry?.fiscal_year)
    ? `${_snapshotEntry.quarter} FY${String(_snapshotEntry.fiscal_year).slice(-2)}`
    : 'latest available';

  const revOp      = _latest(rawBatch?.REV_OP);
  const totalInc   = _latest(rawBatch?.TOTAL_INCOME);
  const pat        = _latest(rawBatch?.PAT);
  const pbt        = _latest(rawBatch?.PBT);
  const finCost    = _latest(rawBatch?.FIN_COST);
  const totalAssets= _latest(rawBatch?.TOTAL_ASSETS);
  const currLiab   = _latest(rawBatch?.CURR_LIAB);
  const ebit       = _latest(derivedBatch?.EBIT);
  const roce       = _latest(derivedBatchAll?.ROCE);
  const roa        = _latestAny(derivedBatch?.ROA,   derivedBatchAll?.ROA);
  const roe        = _latestAny(derivedBatch?.ROE,   derivedBatchAll?.ROE);
  const capex      = _latestAny(derivedBatch?.CAPEX, derivedBatchAll?.CAPEX);
  const fcf        = _latestAny(derivedBatch?.FCF,   derivedBatchAll?.FCF);

  return `SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}

══════════════════════════════════════════════════════════
A. SUBJECT COMPANY FINANCIAL SNAPSHOT (${snapshotPeriod})
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
  ${_sparklineWithFallback(derivedBatch?.ROCE, derivedBatchAll?.ROCE)}

══════════════════════════════════════════════════════════
B. INDUSTRY ANALYSIS FROM TRANSCRIPTS
══════════════════════════════════════════════════════════

### SUBJECT — ${subjectTicker}
${subjectText}

### PEERS
${peerText}

Period context: All snapshot values above are from ${snapshotPeriod}. Mention the period when you metric value are filled.`;
}

// ─── Main exported prompt builder ────────────────────────────────────────────

/**
 * Build the industry prompt.
 *
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {{ callId, industryAnalysis }[]} subjectData
 * @param {{ callId, industryAnalysis }[]} peerData
 * @param {{ rawBatch, derivedBatch, derivedBatchAll?, bfsi? }} computedMetrics
 * @param {string|null} [customInstructions]
 * @param {string|null} [dbTemplate=null]   - promptTemplate from DB
 * @param {string|null} [dbInstructions=null] - defaultInstructions from DB
 */
function industryPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics, customInstructions, dbTemplate, dbInstructions) {
  if (!dbTemplate)      throw new Error('[industryPrompt] dbTemplate is required — configure skill "ofactor-industry" in DB');
  if (!dbInstructions)  throw new Error('[industryPrompt] dbInstructions is required — configure skill "ofactor-industry" in DB');

  const dataBlock    = buildDataBlock(subjectTicker, industry, subjectData, peerData, computedMetrics);
  const instructions = customInstructions ?? dbInstructions;

  return dbTemplate
    .replace(/\{\{INDUSTRY\}\}/g, industry)
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', instructions);
}

module.exports = { industryPrompt, buildDataBlock, METRICS };
