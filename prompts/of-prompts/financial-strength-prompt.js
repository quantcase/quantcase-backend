'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

/** Latest non-null value from a time-series array, or null. */
function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

/**
 * Render a KPI time-series as "period: value" pairs for the last N periods.
 * Returns 'N/A' when no data is available.
 */
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

/**
 * @param {string} subjectTicker
 * @param {{ callId, financialStrength }[]} subjectData  - subject only, no peers
 * @param {{ rawBatch: Record<string, Array>, derivedBatch: Record<string, Array>, bfsi: boolean }} computedMetrics
 */
function financialStrengthPrompt(subjectTicker, subjectData, computedMetrics) {
  const { rawBatch, derivedBatch, bfsi = false } = computedMetrics;

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeFinancialStrength(r)).join('\n\n---\n\n')
    : '(No subject financial strength data available)';

  const schemaString = JSON.stringify({ financial_strength: OFactorResponseSchema.financial_strength }, null, 2);

  const fmt  = v => v != null ? v : 'N/A';
  const pct  = v => v != null ? v + '%' : 'N/A';

  // Income statement (latest)
  const revOp    = _latest(rawBatch?.REV_OP);
  const pat      = _latest(rawBatch?.PAT);
  const pbt      = _latest(rawBatch?.PBT);
  const finCost  = _latest(rawBatch?.FIN_COST);
  const depAmort = _latest(rawBatch?.DEP_AMORT);
  const cfo      = _latest(rawBatch?.CFO);
  const provCont = _latest(rawBatch?.PROV_CONT);

  // Balance sheet (latest)
  const debtLt      = _latest(rawBatch?.DEBT_LT);
  const debtSt      = _latest(rawBatch?.DEBT_ST);
  const cashEquiv   = _latest(rawBatch?.CASH_EQUIV);
  const totalAssets = _latest(rawBatch?.TOTAL_ASSETS);
  const currLiab    = _latest(rawBatch?.CURR_LIAB);
  const eqCap       = _latest(rawBatch?.EQ_SHARE_CAP);
  const reserves    = _latest(rawBatch?.RES_SURPLUS);

  // Working capital (latest) — non-BFSI meaningful
  const tradeRecv = _latest(rawBatch?.TRADE_RECV);
  const tradePay  = _latest(rawBatch?.TRADE_PAY);
  const inventory = _latest(rawBatch?.INVENTORY);

  // Derived (latest)
  const ebit      = _latest(derivedBatch?.EBIT);       // PPOP for BFSI
  const ebitMargin= _latest(derivedBatch?.EBIT_MARGIN);
  const roce      = _latest(derivedBatch?.ROCE);        // null for BFSI
  const roa       = _latest(derivedBatch?.ROA);
  const roe       = _latest(derivedBatch?.ROE);
  const capex     = _latest(derivedBatch?.CAPEX);
  const fcf       = _latest(derivedBatch?.FCF);

  const ebitLabel = bfsi ? 'PPOP (Pre-Prov. Op. Profit)' : 'EBIT';
  const fcfLabel  = bfsi ? 'Free Cash Flow (CFO-CAPEX-Prov)' : 'Free Cash Flow (CFO-CAPEX)';

  const profitabilityBlock = bfsi
    ? `  Profitability
    ROA                     : ${pct(roa)}
    ROE                     : ${pct(roe)}
    ${ebitLabel.padEnd(24)}: ${fmt(ebit)}
    EBIT / Op Margin        : ${pct(ebitMargin)}`
    : `  Profitability
    ROCE                    : ${pct(roce)}
    ROA                     : ${pct(roa)}
    ROE                     : ${pct(roe)}
    EBIT                    : ${fmt(ebit)}
    EBIT Margin             : ${pct(ebitMargin)}`;

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

  const trendsBlock = bfsi
    ? `── Revenue trend (last 5 years) ──
  ${_sparkline(rawBatch?.REV_OP)}

── PAT trend (last 5 years) ──
  ${_sparkline(rawBatch?.PAT)}

── ROA trend (last 5 years) ──
  ${_sparkline(derivedBatch?.ROA)}

── ROE trend (last 5 years) ──
  ${_sparkline(derivedBatch?.ROE)}

── Free Cash Flow trend (last 5 years) ──
  ${_sparkline(derivedBatch?.FCF)}`
    : `── Revenue trend (last 5 years) ──
  ${_sparkline(rawBatch?.REV_OP)}

── PAT trend (last 5 years) ──
  ${_sparkline(rawBatch?.PAT)}

── FCF trend (last 5 years) ──
  ${_sparkline(derivedBatch?.FCF)}

── ROCE trend (last 5 years) ──
  ${_sparkline(derivedBatch?.ROCE)}

── CFO trend (last 5 years) ──
  ${_sparkline(rawBatch?.CFO)}`;

  const analysisInstructions = bfsi
    ? `Using the financial data above and transcript commentary, assess:
  • Revenue/income growth trajectory — fee-driven, AUM-driven, or interest income-led?
  • Margin quality — PPOP trends, provisioning adequacy, credit cost trajectory
  • ${fcfLabel} quality and capital adequacy signals
  • Asset quality signals from management commentary (NPA, PCR, stress book)
Populate with short and crisp points (maximum 10 words each).`
    : `Using the financial data above and transcript commentary, assess:
  • Revenue growth trajectory — volume/mix driven or purely price-led?
  • Margin expansion — is management confident about sustaining margins?
  • FCF conversion quality and capital deployment discipline
  • Balance sheet strength — debt levels, capex ROI, shareholder returns
Populate with short and crisp points (maximum 10 words each).`;

  return `You are a senior equity research analyst. Assess the financial strength of ${subjectTicker}.
${bfsi ? 'Note: This is a BFSI company. Use BFSI-appropriate metrics (ROA, ROE, PPOP, FCF net of provisions). Do NOT reference ROCE.' : ''}

SUBJECT COMPANY : ${subjectTicker}
SECTOR TYPE     : ${bfsi ? 'BFSI (Financial Services)' : 'Non-BFSI (Operating Company)'}

══════════════════════════════════════════════════════════
A. SUBJECT COMPANY FINANCIAL SNAPSHOT (latest annual / FY)
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
${balanceSheetBlock}
${workingCapitalBlock}

${trendsBlock}

══════════════════════════════════════════════════════════
B. FINANCIAL STRENGTH FROM TRANSCRIPTS (subject only)
══════════════════════════════════════════════════════════

${subjectText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

${analysisInstructions}

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { financialStrengthPrompt };
