'use strict';



const METRICS = [
  { name: 'Revenue from Operations (REV_OP)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Cost of Materials (COST_MAT)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Purchases of Stock-in-Trade (PURCH_STOCK)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Inventory Change (INV_CHG)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Employee Expenses (EMP_EXP)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Other Expenses (OTH_EXP)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Depreciation & Amortisation (DEP_AMORT)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Finance Costs (FIN_COST)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'PAT', type: 'raw_kpi', trend: 'last 5 annual + 10 quarterly' },
  { name: 'PBT', type: 'raw_kpi' },
  { name: 'Cash from Operations (CFO)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Trade Receivables (TRADE_RECV)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Trade Payables (TRADE_PAY)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Inventory (INVENTORY)', type: 'raw_kpi', trend: 'last 10 quarters' },
  { name: 'Long-term Debt (DEBT_LT)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Short-term Debt (DEBT_ST)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Cash & Equivalents (CASH_EQUIV)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Equity Share Capital (EQ_SHARE_CAP)', type: 'raw_kpi' },
  { name: 'Reserves & Surplus (RES_SURPLUS)', type: 'raw_kpi' },
  { name: 'PPE — Property Plant Equipment (ASSET_PPE)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Capital Work-in-Progress (ASSET_CWIP)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'Total Assets (TOTAL_ASSETS)', type: 'raw_kpi' },
  { name: 'Current Liabilities (CURR_LIAB)', type: 'raw_kpi' },
  { name: 'Provisions & Contingencies (PROV_CONT)', type: 'raw_kpi' },
  { name: 'Dividend Payout (DIV_PAYOUT)', type: 'raw_kpi', trend: 'last 5 annual' },
  { name: 'EBIT / PPOP (BFSI)', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'EBIT Margin', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'EBITDA', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'EBITDA Margin', type: 'derived_kpi' },
  { name: 'PAT Margin', type: 'derived_kpi' },
  { name: 'ROCE', type: 'derived_kpi', trend: 'last 5 annual' },
  { name: 'ROA', type: 'derived_kpi' },
  { name: 'ROE', type: 'derived_kpi' },
  { name: 'CAPEX', type: 'derived_kpi', trend: 'last 5 annual' },
  { name: 'FCF', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'DSO — Days Sales Outstanding', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'DIO — Days Inventory Outstanding', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'DPO — Days Payable Outstanding', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'CCC — Cash Conversion Cycle', type: 'derived_kpi', trend: 'last 10 quarters' },
  { name: 'Subject financial strength commentary from transcripts', type: 'qualitative' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

function _latestEntry(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1) ?? null;
}

function _entryPeriodStr(entry) {
  if (!entry || !entry.quarter || !entry.fiscal_year) return null;
  return `${entry.quarter} FY${String(entry.fiscal_year).slice(-2)}`;
}

function _sparkline(series, n = 5) {
  if (!Array.isArray(series)) return 'N/A';
  const rows = series.filter(s => s.value != null).slice(-n);
  if (!rows.length) return 'N/A';
  return rows.map(r => `${r.period}: ${r.value}`).join('  |  ');
}

function serializeFinancialStrength(row) {
  if (!row) return '(No data available)';
  const { callId, financialStrength: fs } = row;
  const parts = [`[Call: ${callId}]`];
  if (!fs) { parts.push('(No financial strength data)'); return parts.join('\n'); }
  parts.push(JSON.stringify(fs, null, 2));
  return parts.join('\n');
}


// ─── Data block builder ───────────────────────────────────────────────────────

/**
 * Assemble the runtime data block. Contains all dynamic financial data.
 */
function buildDataBlock(subjectTicker, subjectData, computedMetrics) {
  const { rawBatchAll = {}, derivedBatchAll = {}, bfsi = false, marketCap = null } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeFinancialStrength(r)).join('\n\n---\n\n')
    : '(No subject financial strength data available)';

  const fmt  = v => v != null ? v : 'N/A';
  const pct  = v => v != null ? v + '%' : 'N/A';

  const _snapshotEntry = _latestEntry(rawBatchAll?.REV_OP)
    ?? _latestEntry(rawBatchAll?.PAT)
    ?? _latestEntry(rawBatchAll?.PBT);
  const snapshotPeriod = _entryPeriodStr(_snapshotEntry) ?? 'latest available';

  const revOp    = _latest(rawBatchAll?.REV_OP);
  const pat      = _latest(rawBatchAll?.PAT);
  const pbt      = _latest(rawBatchAll?.PBT);
  const finCost  = _latest(rawBatchAll?.FIN_COST);
  const depAmort = _latest(rawBatchAll?.DEP_AMORT);
  const cfo      = _latest(rawBatchAll?.CFO);
  const provCont = _latest(rawBatchAll?.PROV_CONT);

  const debtLt      = _latest(rawBatchAll?.DEBT_LT);
  const debtSt      = _latest(rawBatchAll?.DEBT_ST);
  const cashEquiv   = _latest(rawBatchAll?.CASH_EQUIV);
  const totalAssets = _latest(rawBatchAll?.TOTAL_ASSETS);
  const currLiab    = _latest(rawBatchAll?.CURR_LIAB);
  const eqCap       = _latest(rawBatchAll?.EQ_SHARE_CAP);
  const reserves    = _latest(rawBatchAll?.RES_SURPLUS);

  const tradeRecv = _latest(rawBatchAll?.TRADE_RECV);
  const tradePay  = _latest(rawBatchAll?.TRADE_PAY);
  const inventory = _latest(rawBatchAll?.INVENTORY);

  const ebit       = _latest(derivedBatchAll?.EBIT);
  const ebitMargin = _latest(derivedBatchAll?.EBIT_MARGIN);
  const roce       = _latest(derivedBatchAll?.ROCE);
  const roa        = _latest(derivedBatchAll?.ROA);
  const roe        = _latest(derivedBatchAll?.ROE);
  const capex      = _latest(derivedBatchAll?.CAPEX);
  const fcf        = _latest(derivedBatchAll?.FCF);

  const costMat    = _latest(rawBatchAll?.COST_MAT);
  const purchStock = _latest(rawBatchAll?.PURCH_STOCK);
  const invChg     = _latest(rawBatchAll?.INV_CHG);
  let grossMargin = null;
  if (!bfsi && revOp != null && revOp !== 0 && costMat != null) {
    const cogs = costMat + (purchStock ?? 0) + (invChg ?? 0);
    grossMargin = parseFloat(((revOp - cogs) / revOp * 100).toFixed(2));
  }

  let interestCoverage = null;
  if (ebit != null && finCost != null && finCost !== 0) {
    interestCoverage = parseFloat((ebit / finCost).toFixed(2));
  }

  const ebitLabel = bfsi ? 'PPOP (Pre-Prov. Op. Profit)' : 'EBIT';
  const fcfLabel  = bfsi ? 'Free Cash Flow (CFO-CAPEX-Prov)' : 'Free Cash Flow (CFO-CAPEX)';

  let nimCoverage = null;
  if (bfsi && ebit != null && finCost != null && finCost !== 0) {
    nimCoverage = parseFloat((ebit / finCost).toFixed(2));
  }

  const profitabilityBlock = bfsi
    ? `  Profitability
    ROA                     : ${pct(roa)}
    ROE                     : ${pct(roe)}
    ${ebitLabel.padEnd(24)}: ${fmt(ebit)}
    EBIT / Op Margin        : ${pct(ebitMargin)}
    NIM Coverage (PPOP/FIN_COST): ${nimCoverage != null ? nimCoverage + 'x' : 'N/A'}`
    : `  Profitability
    Gross Margin            : ${pct(grossMargin)}
    ROCE                    : ${pct(roce)}
    ROA                     : ${pct(roa)}
    ROE                     : ${pct(roe)}
    EBIT                    : ${fmt(ebit)}
    EBIT Margin             : ${pct(ebitMargin)}
    Interest Coverage       : ${interestCoverage != null ? interestCoverage + 'x' : 'N/A'}`;

  const balanceSheetBlock = bfsi
    ? `  Balance Sheet
    Total Assets            : ${fmt(totalAssets)}
    Equity Capital          : ${fmt(eqCap)}
    Reserves & Surplus      : ${fmt(reserves)}
    Cash & Equivalents      : ${fmt(cashEquiv)}
    Provisions & Cont.      : ${fmt(provCont)}`
    : `  Balance Sheet
    Total Assets            : ${fmt(totalAssets)}
    Current Liabilities     : ${fmt(currLiab)}
    Long-term Debt          : ${fmt(debtLt)}
    Short-term Debt         : ${fmt(debtSt)}
    Cash & Equivalents      : ${fmt(cashEquiv)}
    Equity Capital          : ${fmt(eqCap)}
    Reserves & Surplus      : ${fmt(reserves)}`;

  const workingCapitalBlock = bfsi ? '' : `
  Working Capital
    Trade Receivables       : ${fmt(tradeRecv)}
    Trade Payables          : ${fmt(tradePay)}
    Inventory               : ${fmt(inventory)}`;

  function _qSeries(series, n = 10) {
    if (!Array.isArray(series)) return [];
    return series.filter(s => s.value != null).slice(-n).map(s => ({
      quarter: `${s.quarter}'${String(s.fiscal_year ?? s.year ?? '').slice(-2)}`,
      value: s.value
    }));
  }

  const revOpQ   = _qSeries(rawBatchAll?.REV_OP);
  const ebitQ    = _qSeries(derivedBatchAll?.EBIT);
  const empExpQ  = _qSeries(rawBatchAll?.EMP_EXP);
  const othExpQ  = _qSeries(rawBatchAll?.OTH_EXP);
  const depAmortQ= _qSeries(rawBatchAll?.DEP_AMORT);
  const patQ     = _qSeries(rawBatchAll?.PAT);
  const cfoQ     = _qSeries(rawBatchAll?.CFO);
  const capexQ   = _qSeries(derivedBatchAll?.CAPEX);
  const fcfQ     = _qSeries(derivedBatchAll?.FCF);

  function _sameQtrYoy(series) {
    if (series.length < 2) return null;
    const curr = series[series.length - 1];
    const qLabel = curr.quarter.split("'")[0];
    for (let i = series.length - 2; i >= Math.max(0, series.length - 6); i--) {
      if (series[i].quarter.split("'")[0] === qLabel) {
        const prev = series[i].value;
        if (!prev || prev === 0) return null;
        return parseFloat(((curr.value - prev) / Math.abs(prev) * 100).toFixed(1));
      }
    }
    const prev = series[series.length - 2].value;
    if (!prev || prev === 0) return null;
    return parseFloat(((curr.value - prev) / Math.abs(prev) * 100).toFixed(1));
  }

  const ebitGrowthYoy   = _sameQtrYoy(ebitQ);
  const revGrowthYoy    = _sameQtrYoy(revOpQ);
  const leverageSpread  = (ebitGrowthYoy != null && revGrowthYoy != null)
    ? parseFloat((ebitGrowthYoy - revGrowthYoy).toFixed(1))
    : null;

  function _computeWcDays(raw) {
    const rev    = raw?.REV_OP      ?? [];
    const recv   = raw?.TRADE_RECV  ?? [];
    const inv    = raw?.INVENTORY   ?? [];
    const pay    = raw?.TRADE_PAY   ?? [];
    const mat    = raw?.COST_MAT    ?? [];
    const purch  = raw?.PURCH_STOCK ?? [];
    const invChgS = raw?.INV_CHG   ?? [];
    const n = rev.length;
    const results = [];
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (!r?.value) continue;
      const annRev = r.value * 4;
      const cogs   = ((mat[i]?.value ?? 0) + (purch[i]?.value ?? 0) + (invChgS[i]?.value ?? 0)) * 4;
      const rcv = recv[i]?.value, iiv = inv[i]?.value, tpv = pay[i]?.value;
      const dso = rcv != null ? parseFloat((rcv / annRev * 365).toFixed(1)) : null;
      const dio = iiv != null && cogs > 0 ? parseFloat((iiv / cogs * 365).toFixed(1)) : null;
      const dpo = tpv != null && cogs > 0 ? parseFloat((tpv / cogs * 365).toFixed(1)) : null;
      const ccc = (dso != null && dio != null && dpo != null) ? parseFloat((dso + dio - dpo).toFixed(1)) : null;
      const wc  = (rcv ?? 0) + (iiv ?? 0) - (tpv ?? 0);
      const wc_pct = r.value > 0 ? parseFloat((wc / r.value * 100).toFixed(1)) : null;
      results.push({
        quarter: `${r.quarter}'${String(r.fiscal_year ?? '').slice(-2)}`,
        dso, dio, dpo, ccc, wc_pct
      });
    }
    return results.slice(-10);
  }

  const wcComputed = bfsi ? [] : _computeWcDays(rawBatchAll);

  const debtLtQ4   = _qSeries(rawBatchAll?.DEBT_LT);
  const debtStQ4   = _qSeries(rawBatchAll?.DEBT_ST);
  const cashQ4     = _qSeries(rawBatchAll?.CASH_EQUIV);
  const divPayoutQ4= _qSeries(rawBatchAll?.DIV_PAYOUT);
  const patQ4      = _qSeries(rawBatchAll?.PAT);
  const eqCapQ4    = _qSeries(rawBatchAll?.EQ_SHARE_CAP);
  const reservesQ4 = _qSeries(rawBatchAll?.RES_SURPLUS);

  function _tableBlock(label, series) {
    if (!series.length) return `${label}: N/A`;
    return `${label}: ${series.map(r => `${r.quarter}=${r.value}`).join(' | ')}`;
  }

  const fixedCostTrendsBlock = `
── Fixed Cost Trends (% of Revenue, quarterly) ──
${_tableBlock('EMP_EXP %', empExpQ.map((r, i) => ({ quarter: r.quarter, value: revOpQ[i]?.value ? parseFloat((r.value / revOpQ[i].value * 100).toFixed(1)) : null })))}
${_tableBlock('OTH_EXP %', othExpQ.map((r, i) => ({ quarter: r.quarter, value: revOpQ[i]?.value ? parseFloat((r.value / revOpQ[i].value * 100).toFixed(1)) : null })))}
${_tableBlock('DEP_AMORT %', depAmortQ.map((r, i) => ({ quarter: r.quarter, value: revOpQ[i]?.value ? parseFloat((r.value / revOpQ[i].value * 100).toFixed(1)) : null })))}
${_tableBlock('EBIT %',   ebitQ.map((r, i) => ({ quarter: r.quarter, value: revOpQ[i]?.value ? parseFloat((r.value / revOpQ[i].value * 100).toFixed(1)) : null })))}
Note: Use these to compute DOL = (EBIT_growth%) / (REV_OP_growth%) per quarter.`;

  const _wcRow = (label, key) => {
    const vals = wcComputed.map(r => `${r.quarter}=${r[key] ?? 'N/A'}`).join(' | ');
    return `${label}: ${vals || 'N/A'}`;
  };

  const wcTrendsBlock = bfsi ? '' : `
── Working Capital Days (computed quarterly) ──
${_wcRow('DSO (Debtor Days)',   'dso')}
${_wcRow('DIO (Inventory Days)','dio')}
${_wcRow('DPO (Days Payable)',  'dpo')}
${_wcRow('CCC',                 'ccc')}
${_wcRow('WC% of Revenue',      'wc_pct')}
Note: DSO=TRADE_RECV/(REV_OP×4)×365; DIO=INVENTORY/(COGS×4)×365; DPO=TRADE_PAY/(COGS×4)×365; CCC=DSO+DIO-DPO`;

  const opLevMetricsBlock = `
── Operating Leverage Pre-computed Metrics ──
Revenue Growth YoY (same quarter vs prior year): ${revGrowthYoy != null ? revGrowthYoy + '%' : 'N/A'}
EBIT Growth YoY    (same quarter vs prior year): ${ebitGrowthYoy != null ? ebitGrowthYoy + '%' : 'N/A'}
Leverage Spread (EBIT growth − Rev growth): ${leverageSpread != null ? leverageSpread + 'pp' : 'N/A'}
Note: Use these EXACT values for operating_leverage.metrics.revenue_growth_yoy, ebit_growth_yoy, leverage_spread. Do NOT recompute.`;

  const fcfTrendsBlock = `
── FCF Conversion Quarterly (FCF/PAT %) ──
${(() => {
  const pairs = fcfQ.map((r, i) => {
    const p = patQ[i];
    if (!p || !p.value) return null;
    return { quarter: r.quarter, value: parseFloat((r.value / p.value * 100).toFixed(1)) };
  }).filter(Boolean);
  return _tableBlock('FCF/PAT %', pairs);
})()}
${_tableBlock('CFO (quarterly)', cfoQ)}
${_tableBlock('FCF (quarterly)', fcfQ)}
${_tableBlock('CAPEX (quarterly)', capexQ)}`;

  const capitalStructureBlock = `
── Capital Structure History (latest available quarters) ──
${_tableBlock('DEBT_LT', debtLtQ4)}
${_tableBlock('DEBT_ST', debtStQ4)}
${_tableBlock('CASH_EQUIV', cashQ4)}
${_tableBlock('PAT', patQ4)}
${_tableBlock('DIV_PAYOUT %', divPayoutQ4)}
${_tableBlock('EQ_SHARE_CAP', eqCapQ4)}
${_tableBlock('RESERVES', reservesQ4)}`;

  const trendsBlock = bfsi
    ? `── Revenue trend (last 10 quarters) ──
  ${_sparkline(rawBatchAll?.REV_OP)}

── PAT trend (last 10 quarters) ──
  ${_sparkline(rawBatchAll?.PAT)}

── ROA trend (last 10 quarters) ──
  ${_sparkline(derivedBatchAll?.ROA)}

── ROE trend (last 10 quarters) ──
  ${_sparkline(derivedBatchAll?.ROE)}

── Free Cash Flow trend (last 10 quarters) ──
  ${_sparkline(derivedBatchAll?.FCF)}`
    : `── Revenue trend (last 10 quarters) ──
  ${_sparkline(rawBatchAll?.REV_OP)}

── PAT trend (last 10 quarters) ──
  ${_sparkline(rawBatchAll?.PAT)}

── FCF trend (last 10 quarters) ──
  ${_sparkline(derivedBatchAll?.FCF)}

── ROCE trend (last 10 quarters) ──
  ${_sparkline(derivedBatchAll?.ROCE)}

── CFO trend (last 10 quarters) ──
  ${_sparkline(rawBatchAll?.CFO)}`;

  return `You are a senior equity research analyst. Assess the financial strength of ${subjectTicker}.
${bfsi ? 'Note: This is a BFSI company. Use BFSI-appropriate metrics (ROA, ROE, PPOP, FCF net of provisions). Do NOT reference ROCE.' : ''}

SUBJECT COMPANY : ${subjectTicker}
SECTOR TYPE     : ${bfsi ? 'BFSI (Financial Services)' : 'Non-BFSI (Operating Company)'}

══════════════════════════════════════════════════════════
A. SUBJECT COMPANY FINANCIAL SNAPSHOT (${snapshotPeriod})
══════════════════════════════════════════════════════════

  Income Statement
    Revenue from Operations : ${fmt(revOp)}
    ${ebitLabel.padEnd(24)}: ${fmt(ebit)}
    PBT                     : ${fmt(pbt)}
    PAT                     : ${fmt(pat)}
    Finance Costs           : ${fmt(finCost)}
    Depreciation & Amort    : ${fmt(depAmort)}

${profitabilityBlock}

  Cash Flow & Capital
    Cash from Operations    : ${fmt(cfo)}
    CAPEX                   : ${fmt(capex)}
    ${fcfLabel.padEnd(24)}: ${fmt(fcf)}
    Market Cap              : ${marketCap != null ? marketCap + ' Cr' : 'N/A'}
${balanceSheetBlock}
${workingCapitalBlock}

${trendsBlock}

${fixedCostTrendsBlock}

${opLevMetricsBlock}

${wcTrendsBlock}

${fcfTrendsBlock}

${capitalStructureBlock}

══════════════════════════════════════════════════════════
B. FINANCIAL STRENGTH FROM TRANSCRIPTS (subject only)
══════════════════════════════════════════════════════════

${subjectText}`;
}

// ─── Main exported prompt builder ────────────────────────────────────────────

/**
 * Build the financial strength core prompt (core metrics + final_scoring only).
 * extras are computed locally by computeFinancialStrengthExtras and then enriched
 * by a second lightweight LLM call (ofactor-financial-strength-insights).
 *
 * @param {string} subjectTicker
 * @param {{ callId, financialStrength }[]} subjectData
 * @param {{ rawBatch, derivedBatch, rawBatchAll?, derivedBatchAll?, bfsi?, marketCap? }} computedMetrics
 * @param {string|null} [customInstructions]
 * @param {string|null} [dbTemplate=null]    - promptTemplate from DB (static scoring/output section)
 * @param {string|null} [dbInstructions=null] - defaultInstructions from DB
 */
function financialStrengthPrompt(subjectTicker, subjectData, computedMetrics, customInstructions, dbTemplate, dbInstructions) {
  if (!dbTemplate)     throw new Error('[financialStrengthPrompt] dbTemplate is required — configure skill "ofactor-financial-strength-core" in DB');
  if (!dbInstructions) throw new Error('[financialStrengthPrompt] dbInstructions is required — configure skill "ofactor-financial-strength-core" in DB');

  const dataBlock    = buildDataBlock(subjectTicker, subjectData, computedMetrics);
  const instructions = customInstructions ?? dbInstructions;

  return `${dataBlock}

${dbTemplate.replace('{{DEFAULT_INSTRUCTIONS}}', instructions)}`;
}

module.exports = { financialStrengthPrompt, buildDataBlock, METRICS };
