'use strict';

// promptTemplate and outputSchema live entirely in the DB (Skill slug: "deal-analysis").
// This file only contains the data-block builder and the prompt assembler
// that injects it into the DB-sourced template.

/**
 * Assemble the runtime data block from precomputed financial metrics.
 */
function buildDataBlock(
  ticker, companyName, industry, cmp,
  stockEps, stockPe, industryEps, industryPe,
  recentSummaries = [],
  stockRev = null, stockRoce = null,
  ebitMargin = null, roe = null, cashConversionPct = null, industryRev = null
) {
  const latestQuarterlyEps = stockEps?.latestValue ?? null;
  const annualizedEpsRunRate = latestQuarterlyEps != null
    ? parseFloat((latestQuarterlyEps * 4).toFixed(2))
    : null;

  const currentPe       = stockPe?.latestPe   ?? null;
  const avgHistoricalPe = stockPe?.avgPe       ?? null;
  const historicalPeCagr = stockPe?.value      ?? null;
  const peSpanYears     = stockPe?.spanYears   ?? null;

  const industryAvgPe   = industryPe?.avgLatestPe ?? null;
  const industryPeCagr  = industryPe?.value       ?? null;

  const companyEpsCagr  = stockEps?.value         ?? null;
  const companyRevCagr  = stockRev?.value          ?? null;
  const companyRoce     = stockRoce?.value         ?? null;
  const companyEbitMargin      = ebitMargin        ?? null;
  const companyRoe             = roe               ?? null;
  const companyCashConversion  = cashConversionPct ?? null;
  const industryRevCagrVal     = industryRev?.value ?? null;

  const derivedCmp = (cmp == null && currentPe != null && annualizedEpsRunRate != null)
    ? parseFloat((currentPe * annualizedEpsRunRate).toFixed(2))
    : cmp;
  const displayCmp = derivedCmp ?? 'N/A';

  const epsHistoricalNote = stockEps?.type === 'partial_cagr'
    ? `NOTE: Only ${stockEps.periodsUsed} quarters of EPS data available (span: ${stockEps.spanYears} yrs). ` +
      `Historical CAGR of ${stockEps.value}% is annualized from a very short window — use as a directional signal, not a hard anchor.`
    : stockEps?.type === 'latest_value'
    ? `NOTE: Only 1 quarter of EPS data available (no CAGR computable). Latest quarterly EPS = ₹${latestQuarterlyEps}.`
    : `Historical EPS CAGR: ${stockEps?.value}% over ${stockEps?.spanYears} years.`;

  const industryEpsNote = (industryEps?.validTickerCount ?? 0) < 3
    ? `NOTE: Only ${industryEps?.validTickerCount ?? 0} of ${industryEps?.tickerCount ?? 0} industry peers had sufficient EPS history — treat industry EPS CAGR as low-confidence.`
    : `Industry EPS CAGR based on ${industryEps.validTickerCount}/${industryEps.tickerCount} peers.`;

  const execAlphaRatio = (companyEpsCagr != null && industryEps?.value != null && industryEps.value > 0)
    ? parseFloat((companyEpsCagr / industryEps.value).toFixed(1))
    : null;

  let managementContext = '';
  let managementScore = null;

  if (recentSummaries.length > 0) {
    const allSignals = recentSummaries.flatMap(s => (s.governanceSignals ?? []));
    const signals = allSignals
      .slice(0, 8)
      .map(g => `  - ${g?.signal ?? (typeof g === 'string' ? g : JSON.stringify(g))}`)
      .join('\n');

    const tone = recentSummaries.at(-1)?.tone ?? null;
    const confidence = recentSummaries.at(-1)?.confidence ?? null;

    const positiveKeywords = ['strong', 'beat', 'exceeded', 'improved', 'consistent', 'growth', 'delivered', 'outperform'];
    const negativeKeywords = ['missed', 'weak', 'delay', 'declined', 'pressure', 'risk', 'lower', 'below'];
    let score = 5;
    for (const g of allSignals) {
      const text = String(g?.signal ?? (typeof g === 'string' ? g : '')).toLowerCase();
      if (positiveKeywords.some(k => text.includes(k))) score += 0.3;
      if (negativeKeywords.some(k => text.includes(k))) score -= 0.3;
    }
    managementScore = Math.min(10, Math.max(1, parseFloat(score.toFixed(1))));

    managementContext = `
## Management Quality Signals (from recent earnings calls)
${signals || '  - No governance signals available'}
- Latest Call Tone: ${tone ?? 'N/A'}
- Management Confidence Level: ${confidence ?? 'N/A'}
- Computed Management Quality Score: ${managementScore}/10
`;
  }

  return `## Company Context
- Ticker:       ${ticker}
- Company:      ${companyName}
- Industry:     ${industry}
- CMP:          ₹${displayCmp}
- Forecast Horizon: 3 years

---

## EPS & Profitability Data (from kpi_values)
- Latest Quarterly EPS:      ₹${latestQuarterlyEps ?? 'N/A'}
- Annualized EPS Run-Rate:   ₹${annualizedEpsRunRate ?? 'N/A'} (quarterly × 4)
- ${epsHistoricalNote}
- Company EPS 5yr CAGR:      ${companyEpsCagr != null ? `${companyEpsCagr}%` : 'N/A'}
- Company Revenue 5yr CAGR:  ${companyRevCagr != null ? `${companyRevCagr}%` : 'N/A'}
- Company ROCE (latest):     ${companyRoce != null ? `${companyRoce}%` : 'N/A'}
- Company EBIT Margin (latest): ${companyEbitMargin != null ? `${companyEbitMargin}%` : 'N/A'}
- Company ROE (latest):      ${companyRoe != null ? `${companyRoe}%` : 'N/A'}
- Company Cash Conversion:   ${companyCashConversion != null ? `${companyCashConversion}% (FCF/PAT)` : 'N/A'}

## P/E Ratio Data (from daily market data)
- Current P/E (latest):           ${currentPe ?? 'N/A'}x
- Historical P/E CAGR:            ${historicalPeCagr != null ? `${historicalPeCagr}% over ${peSpanYears} yrs` : 'N/A'}
- Average P/E over history:       ${avgHistoricalPe ?? 'N/A'}x

## Industry Benchmarks
- Industry Average Latest P/E:    ${industryAvgPe ?? 'N/A'}x  (${industryPe?.tickerCount ?? 0} peers)
- Industry P/E CAGR (3yr avg):    ${industryPeCagr != null ? `${industryPeCagr}%` : 'N/A'}
- Industry EPS CAGR:              ${industryEps?.value != null ? `${industryEps.value}%` : 'N/A'}
- Industry Revenue CAGR:          ${industryRevCagrVal != null ? `${industryRevCagrVal}%` : 'N/A'}
- ${industryEpsNote}
- Execution Alpha (historical):   ${execAlphaRatio != null ? `${execAlphaRatio}x (company EPS CAGR / industry EPS CAGR)` : 'N/A'}
${managementContext}
---

## Key Parameters for Scenario Calculations
- CMP: ₹${displayCmp}
- Current P/E: ${currentPe ?? 'N/A'}x
- Historical avg P/E: ${avgHistoricalPe ?? 'N/A'}x
- Industry avg P/E: ${industryAvgPe ?? 'N/A'}x
- Management quality score: ${managementScore != null ? `${managementScore}/10` : 'compute from governance signals'}
- Company EPS CAGR: ${companyEpsCagr != null ? `${companyEpsCagr}%` : 'N/A'}
- Industry EPS CAGR: ${industryEps?.value != null ? `${industryEps.value}%` : 'N/A'}
- Company EBIT Margin: ${companyEbitMargin != null ? `${companyEbitMargin}%` : 'N/A'}
- Company ROE: ${companyRoe != null ? `${companyRoe}%` : 'N/A'}
- Company ROCE: ${companyRoce != null ? `${companyRoce}%` : 'N/A'}
- Company Revenue CAGR: ${companyRevCagr != null ? `${companyRevCagr}%` : 'N/A'}
- Industry Revenue CAGR: ${industryRevCagrVal != null ? `${industryRevCagrVal}%` : 'N/A'}
- Cash Conversion: ${companyCashConversion != null ? `${companyCashConversion}% (FCF/PAT)` : 'N/A'}`;
}

/**
 * @param {string}      ticker
 * @param {string}      companyName
 * @param {string}      industry
 * @param {number|null} cmp
 * @param {object}      stockEps
 * @param {object}      stockPe
 * @param {object}      industryEps
 * @param {object}      industryPe
 * @param {Array}       recentSummaries
 * @param {object}      stockRev
 * @param {object}      stockRoce
 * @param {number|null} ebitMargin
 * @param {number|null} roe
 * @param {number|null} cashConversionPct
 * @param {object|null} industryRev
 * @param {string}      dbTemplate        - DB promptTemplate (Skill slug: "deal-analysis")
 * @returns {string}
 */
function dealAnalysisPrompt(
  ticker, companyName, industry, cmp,
  stockEps, stockPe, industryEps, industryPe,
  recentSummaries = [],
  stockRev = null, stockRoce = null,
  ebitMargin = null, roe = null, cashConversionPct = null, industryRev = null,
  dbTemplate = null
) {
  if (!dbTemplate) throw new Error('[dealAnalysisPrompt] template must come from DB — Skill slug: "deal-analysis"');

  const dataBlock = buildDataBlock(
    ticker, companyName, industry, cmp,
    stockEps, stockPe, industryEps, industryPe,
    recentSummaries, stockRev, stockRoce,
    ebitMargin, roe, cashConversionPct, industryRev
  );
  return dbTemplate.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { dealAnalysisPrompt, buildDataBlock };
