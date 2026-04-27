'use strict';

/**
 * Build the financial strength insights data block.
 *
 * The LLM instructions, output format, and schema are stored in the DB skill
 * "ofactor-financial-strength-insights". This function only assembles the
 * pre-computed numeric context that the LLM needs to write the text blurbs.
 *
 * @param {string} subjectTicker
 * @param {object} extras  - output of computeFinancialStrengthExtras (nulls = fields LLM must fill)
 * @param {boolean} bfsi
 * @param {string} dbTemplate  - promptTemplate from DB skill
 */
function financialStrengthInsightsPrompt(subjectTicker, extras, bfsi, dbTemplate) {
  if (!dbTemplate) throw new Error('[financialStrengthInsightsPrompt] dbTemplate is required — configure skill "ofactor-financial-strength-insights" in DB');

  const ol  = extras.operating_leverage  ?? {};
  const fcf = extras.free_cash_flow      ?? {};
  const wc  = extras.working_capital     ?? {};
  const cs  = extras.capital_structure   ?? {};

  const fmt = v => (v != null ? v : 'N/A');

  const olBlock = `── OPERATING LEVERAGE ──
Verdict status : ${fmt(ol.verdict?.status)}
Verdict label  : ${fmt(ol.verdict?.label)}
Leverage spread: ${fmt(ol.metrics?.leverage_spread?.value)}
Revenue growth : ${fmt(ol.metrics?.revenue_growth_yoy?.value)}
EBIT growth    : ${fmt(ol.metrics?.ebit_growth_yoy?.value)}
Fixed cost lines:
${(ol.fixed_cost_lines ?? []).map(l => `  ${l.label}: current=${l.current_pct}% prior=${l.prior_pct}% change=${l.change_bps}bps`).join('\n')}
Total fixed costs: current=${fmt(ol.total_fixed_costs?.current_pct)}% prior=${fmt(ol.total_fixed_costs?.prior_pct)}% change=${fmt(ol.total_fixed_costs?.change_bps)}bps`;

  const fcfBlock = `── FREE CASH FLOW ──
Growth trajectory status : ${fmt(fcf.growth_trajectory?.status)}
FCF CAGR  : ${fmt(fcf.growth_trajectory?.fcf_cagr_pct)}%  (${fmt(fcf.growth_trajectory?.fcf_start)} → ${fmt(fcf.growth_trajectory?.fcf_end)})
PAT CAGR  : ${fmt(fcf.growth_trajectory?.pat_cagr_pct)}%  (${fmt(fcf.growth_trajectory?.pat_start)} → ${fmt(fcf.growth_trajectory?.pat_end)})
OCF TTM   : ${fmt(fcf.ocf_to_fcf?.ocf_ttm)}
CAPEX     : ${fmt(fcf.ocf_to_fcf?.capex)}
FCF TTM   : ${fmt(fcf.ocf_to_fcf?.fcf_ttm)}
Capex/OCF : ${fmt(fcf.ocf_to_fcf?.capex_ocf_pct)}%  status=${fmt(fcf.ocf_to_fcf?.status)}
FCF yield (latest): ${fmt(fcf.fcf_yield?.yield_history?.at(-1)?.yield)}%  zone=${fmt(fcf.fcf_yield?.yield_history?.at(-1)?.zone)}  status=${fmt(fcf.fcf_yield?.status)}`;

  const wcBlock = bfsi ? '' : `── WORKING CAPITAL ──
Quarters : ${(wc.quarters ?? []).join(', ')}
DSO (days): ${(wc.rows?.find(r => r.key === 'dso')?.values ?? []).join(', ')}
DIO (days): ${(wc.rows?.find(r => r.key === 'dio')?.values ?? []).join(', ')}
DPO (days): ${(wc.rows?.find(r => r.key === 'dpo')?.values ?? []).join(', ')}
CCC (days): ${(wc.rows?.find(r => r.key === 'ccc')?.values ?? []).join(', ')}
WC trend verdict: ${fmt(wc.trend_chart?.verdict_badge)}  (${fmt(wc.trend_chart?.verdict_color)})
Signals: ${(wc.signals ?? []).map(s => s.label).join(', ') || 'none'}`;

  const csBlock = `── CAPITAL STRUCTURE ──
Balance sheet status   : ${fmt(cs.balance_sheet?.status)}
Cash investments       : ${fmt(cs.balance_sheet?.cash_investments)}
Gross debt             : ${fmt(cs.balance_sheet?.gross_debt)}
Net cash               : ${fmt(cs.balance_sheet?.net_cash)}
Debt trajectory status : ${fmt(cs.debt_trajectory?.status)}
Debt bars              : ${(cs.debt_trajectory?.bars ?? []).map(b => `${b.label}=${b.value}`).join(', ')}
Peak debt              : ${fmt(cs.debt_trajectory?.peak_debt)}  Reduction: ${fmt(cs.debt_trajectory?.reduction_pct)}
Equity allocation status: ${fmt(cs.equity_allocation?.status)}
ROE                    : ${fmt(cs.equity_allocation?.roe)}
Payout trend           : ${fmt(cs.equity_allocation?.payout_trend)}
Capex intensity status : ${fmt(cs.capex_intensity?.status)}
Capex/Revenue          : ${fmt(cs.capex_intensity?.metrics?.[0]?.value)}
Capex/OCF              : ${fmt(cs.capex_intensity?.metrics?.[1]?.value)}`;

  const dataBlock = `You are a senior equity research analyst writing short text insights for ${subjectTicker}.
SECTOR TYPE: ${bfsi ? 'BFSI (Financial Services)' : 'Non-BFSI (Operating Company)'}

All numeric data below has already been computed. Your ONLY task is to write the short text blurbs specified in the instructions below.

${olBlock}

${fcfBlock}

${bfsi ? '' : wcBlock}

${csBlock}`;

  return `${dataBlock}

${dbTemplate}`;
}

module.exports = { financialStrengthInsightsPrompt };
