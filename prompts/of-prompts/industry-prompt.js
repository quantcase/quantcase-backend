'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

const DEFAULT_INSTRUCTIONS = `From ALL transcripts (subject + peer), identify:
  • Are the majority of managements talking about volume growth?
  • Are order books or pipelines expanding?
  • Is management guidance on volumes and capex positive or cautious?
  • What are the key demand/supply dynamics in this industry?
Populate with short and crisp points.

Output length guidelines:
  • text.takeaway — ONE punchy sentence, 15 words max. Comma-separated key facts with one metric in parentheses. Example: "High growth, demand rising, no import competition"
  • text.opm_trend.margin_drivers, text.opm_trend.key_observations — 30 words max per item
  • text.opm_trend.forward_outlook — 30 words max
  • text.demand_supply_dynamics.demand, .supply — 4–6 bullet points each, 20 words max per point
  • text.demand_supply_dynamics.net_impact — short thesis narrative in 30 words max`;

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
function industryPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics, customInstructions) {
  const { rawBatch, derivedBatch, derivedBatchAll = {}, bfsi = false } = computedMetrics;

  // Prefer Q4 (annual) value; fall back to latest available quarter.
  // ROCE/ROE/ROA/CAPEX/FCF depend on balance sheet items which may only be
  // present in non-Q4 quarters for some companies (e.g. Dec year-end).
  const _latestAny = (q4Series, allSeries) => _latest(q4Series) ?? _latest(allSeries);

  // For sparklines: use Q4 series if it has any values; otherwise fall back to full series.
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

  const schemaString = JSON.stringify({ industry_overview: OFactorResponseSchema.industry_overview }, null, 2);

  // Latest point-in-time values
  const fmt = v => v != null ? v : 'N/A';

  // Determine snapshot period for the Section A header
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

  return `You are a senior equity research analyst. Produce an industry overview for the ${industry} sector.

SUBJECT COMPANY : ${subjectTicker}
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

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

Period context: All snapshot values above are from ${snapshotPeriod}. Mention the period when you metric value are filled.

${customInstructions ?? DEFAULT_INSTRUCTIONS}

For ALL metrics values: always output a SINGLE specific number or label — never a range (e.g. "₹30,000–40,000 Cr" or "12–15%") and never a division (e.g. "Elecon / Triveni"). If you are uncertain, approximate using the midpoint or mean and state your basis in the sublabel.

For metrics.industry_revenue_ttm: estimate total industry revenue (TTM) for the ${industry} sector using subject company revenue, peer data, and your knowledge. Express in a readable format (e.g. "₹4.2L Cr", "$180B"). Add a "change" field with the date % change (e.g. "+18.2% Q3 FY26"). Use sublabel to clarify source/period.

For metrics.industry_cagr (NON-BFSI only): provide three separate CAGR estimates for the industry revenue — "qoq" (quarter-on-quarter annualised), "one_year" (1Y CAGR), "three_year" (3Y CAGR). Each should be a single % string (e.g. "12.3%"). Use the revenue sparkline data and your knowledge of the sector. Set all fields to null for BFSI companies.

For metrics.industry_aum (BFSI only): estimate total industry AUM — calculated as Gross Advances + Deposits for the ${industry} sector. Express in a readable format (e.g. "₹180L Cr"). Add a "change" field with the YoY % change (e.g. "+14%"). Set to null for non-BFSI companies.

For metrics.current_opm: output a single OPM % value (e.g. "23%") and a "change" field in basis points (e.g. "+120bps" or "-40bps") +date range. Use the EBIT/revenue sparkline above to derive the change. If peer OPMs differ, use weighted average and explain in sublabel.

For metrics.industry_roce: use the ROCE trend above (last 4 Q4s) to populate "value" (latest, e.g. "24.8%") and "change" (YoY change in bps, e.g. "+180bps date range"). This represents the subject company ROCE as a proxy for industry ROCE — note in sublabel if peers differ significantly.${bfsi ? '\n\nThis is a BFSI company. Populate industry_aum; set industry_cagr fields (qoq, one_year, three_year) to null.' : '\n\nThis is a non-BFSI company. Populate industry_cagr (qoq, one_year, three_year); set industry_aum to null.'}

Populate the "final_scoring" field INSIDE the industry_overview JSON object (same level as "metrics"). Award 1 point per check, max 10:
  1. Demand signal is "Strong" → metrics.demand_signal
  2. Supply constraint is "Low" or "Moderate" (not High) → metrics.supply_constraint
  3. Industry revenue TTM change is positive → metrics.industry_revenue_ttm.change
  4. ${bfsi ? 'Industry AUM growth > 12% → metrics.industry_aum.change' : 'Industry CAGR 1Y > 10% → metrics.industry_cagr.one_year'}
  5. ${bfsi ? 'Industry AUM 3Y growth positive → metrics.industry_aum' : 'Industry CAGR 3Y > 8% → metrics.industry_cagr.three_year'}
  6. Operating margin ≥ 12% → metrics.current_opm.value
  7. Operating margin YoY change is positive → metrics.current_opm.change
  8. Industry ROCE ≥ 12% → metrics.industry_roce.value
  9. Industry ROCE change is positive → metrics.industry_roce.change
  10. OPM forward outlook is improving or stable → text.opm_trend.forward_outlook
  status: score >= 7 → "FAVORABLE" (green), score 5–6 → "NEUTRAL" (yellow), score < 5 → "UNFAVORABLE" (red).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { industryPrompt, DEFAULT_INSTRUCTIONS, METRICS };
