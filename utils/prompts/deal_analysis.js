'use strict';

/**
 * Build the deal analysis prompt.
 *
 * @param {string}  ticker
 * @param {string}  companyName
 * @param {string}  industry
 * @param {number|null} cmp              - Current Market Price (₹)
 * @param {object}  stockEps             - { value, type, latestValue, firstValue, spanYears, periodsUsed, note? }
 * @param {object}  stockPe              - { value, type, latestPe, firstPe, avgPe, spanYears, periodsUsed }
 * @param {object}  industryEps          - { value, type, tickerCount, validTickerCount }
 * @param {object}  industryPe           - { value, type, avgLatestPe, tickerCount, validTickerCount }
 * @param {Array}   recentSummaries      - Array of Summary objects (milestones, governanceSignals, tone)
 * @returns {string}
 */
function dealAnalysisPrompt(
  ticker,
  companyName,
  industry,
  cmp,
  stockEps,
  stockPe,
  industryEps,
  industryPe,
  recentSummaries = []
) {
  // ── Derive key numbers ──────────────────────────────────────────────────────
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

  // Estimated CMP if not provided from API
  const derivedCmp = (cmp == null && currentPe != null && annualizedEpsRunRate != null)
    ? parseFloat((currentPe * annualizedEpsRunRate).toFixed(2))
    : cmp;

  const displayCmp = derivedCmp ?? 'N/A';

  // EPS CAGR note
  const epsHistoricalNote = stockEps?.type === 'partial_cagr'
    ? `NOTE: Only ${stockEps.periodsUsed} quarters of EPS data available (span: ${stockEps.spanYears} yrs). ` +
      `Historical CAGR of ${stockEps.value}% is annualized from a very short window — use as a directional signal, not a hard anchor.`
    : stockEps?.type === 'latest_value'
    ? `NOTE: Only 1 quarter of EPS data available (no CAGR computable). Latest quarterly EPS = ₹${latestQuarterlyEps}.`
    : `Historical EPS CAGR: ${stockEps?.value}% over ${stockEps?.spanYears} years.`;

  const industryEpsNote = (industryEps?.validTickerCount ?? 0) < 3
    ? `NOTE: Only ${industryEps?.validTickerCount ?? 0} of ${industryEps?.tickerCount ?? 0} industry peers had sufficient EPS history — treat industry EPS CAGR as low-confidence.`
    : `Industry EPS CAGR based on ${industryEps.validTickerCount}/${industryEps.tickerCount} peers.`;

  // ── Management context from summaries ──────────────────────────────────────
  let managementContext = '';
  if (recentSummaries.length > 0) {
    const signals = recentSummaries
      .flatMap(s => (s.governanceSignals ?? []))
      .slice(0, 8)
      .map(g => `  - ${g.signal ?? g}`)
      .join('\n');

    const tone = recentSummaries.at(-1)?.tone ?? null;
    const confidence = recentSummaries.at(-1)?.confidence ?? null;

    managementContext = `
## Management Quality Signals (from recent earnings calls)
${signals || '  - No governance signals available'}
- Latest Call Tone: ${tone ?? 'N/A'}
- Management Confidence Level: ${confidence ?? 'N/A'}
`;
  }

  // ── Prompt body ────────────────────────────────────────────────────────────
  return `You are a senior quantitative equity analyst specializing in Indian listed equities. Your task is to produce a rigorous Bear / Base / Bull scenario analysis for the following stock.

## Company Context
- Ticker:       ${ticker}
- Company:      ${companyName}
- Industry:     ${industry}
- CMP:          ₹${displayCmp}
- Forecast Horizon: 3 years

---

## EPS Data (from quarterly earnings summaries)
- Latest Quarterly EPS:    ₹${latestQuarterlyEps ?? 'N/A'}
- Annualized EPS Run-Rate: ₹${annualizedEpsRunRate ?? 'N/A'} (quarterly × 4)
- ${epsHistoricalNote}

## P/E Ratio Data (from daily market data)
- Current P/E (latest):           ${currentPe ?? 'N/A'}x
- Historical P/E CAGR:            ${historicalPeCagr != null ? `${historicalPeCagr}% over ${peSpanYears} yrs` : 'N/A'}
- Average P/E over history:       ${avgHistoricalPe ?? 'N/A'}x

## Industry Benchmarks
- Industry Average Latest P/E:    ${industryAvgPe ?? 'N/A'}x  (${industryPe?.tickerCount ?? 0} peers)
- Industry P/E CAGR (3yr avg):    ${industryPeCagr != null ? `${industryPeCagr}%` : 'N/A'}
- Industry EPS CAGR:              ${industryEps?.value != null ? `${industryEps.value}%` : 'N/A'}
- ${industryEpsNote}
${managementContext}
---

## Your Task

Generate three scenarios — Bear, Base, and Bull — each with a specific EPS CAGR assumption for the next 3 years. For each scenario:

1. **EPS CAGR** — choose a realistic annualized EPS growth rate based on the data above:
   - Bear: headwinds, execution miss, or macro compression
   - Base: steady execution, in-line with recent trends
   - Bull: upside surprises, multiple expansion drivers
2. **Forward EPS** — compute: annualized_eps_run_rate × (1 + eps_cagr/100)^3
3. **Exit P/E range** — choose a realistic exit P/E multiple range for each scenario:
   - Anchor to: current P/E (${currentPe}x), historical avg P/E (${avgHistoricalPe}x), industry avg P/E (${industryAvgPe}x)
   - Bear: compress toward industry avg or below; Base: near current or slight compression; Bull: premium expansion
4. **Target Price Range** — forward_eps × exit_pe_low and forward_eps × exit_pe_high
5. **Upside/Downside %** — relative to CMP ₹${displayCmp}
6. **CAGR p.a.** — annualized return from CMP to midpoint of target range over 3 years
7. **Probability** — assign probabilities that SUM TO EXACTLY 100%
8. **Key Drivers** — 3-4 concise bullet points per scenario explaining the thesis

Also generate a **risk_reward_summary** with:
- probability_weighted_return_pct (sum of probability × upside for each scenario)
- risk_reward_ratio (weighted upside / weighted downside, as a decimal like 3.2)
- downside_protection_pct (bear case upside/downside %)
- investment_thesis (2-3 sentence overall thesis)
- key_risks (3-4 items)
- key_catalysts (3-4 items)

---

## Output Format

Return ONLY a valid JSON object with this exact schema. No markdown fences, no explanation — just the JSON:

{
  "scenario_framework": {
    "meta": {
      "ticker": "${ticker}",
      "company_name": "${companyName}",
      "cmp": <number>,
      "forecast_horizon_years": 3,
      "base_annualized_eps": <number>,
      "stock_current_pe": <number>,
      "industry_avg_pe": <number>
    },
    "bear": {
      "eps_cagr_pct": <number>,
      "fy_eps": <number>,
      "exit_pe_low": <number>,
      "exit_pe_high": <number>,
      "exit_pe_rationale": "<string>",
      "target_price_low": <number>,
      "target_price_high": <number>,
      "upside_downside_pct": <number>,
      "cagr_pa_pct": <number>,
      "probability_pct": <number>,
      "key_drivers": ["<string>", "<string>", "<string>"]
    },
    "base": {
      "eps_cagr_pct": <number>,
      "fy_eps": <number>,
      "exit_pe_low": <number>,
      "exit_pe_high": <number>,
      "exit_pe_rationale": "<string>",
      "target_price_low": <number>,
      "target_price_high": <number>,
      "upside_downside_pct": <number>,
      "cagr_pa_pct": <number>,
      "probability_pct": <number>,
      "key_drivers": ["<string>", "<string>", "<string>"]
    },
    "bull": {
      "eps_cagr_pct": <number>,
      "fy_eps": <number>,
      "exit_pe_low": <number>,
      "exit_pe_high": <number>,
      "exit_pe_rationale": "<string>",
      "target_price_low": <number>,
      "target_price_high": <number>,
      "upside_downside_pct": <number>,
      "cagr_pa_pct": <number>,
      "probability_pct": <number>,
      "key_drivers": ["<string>", "<string>", "<string>"]
    }
  },
  "risk_reward_summary": {
    "probability_weighted_return_pct": <number>,
    "risk_reward_ratio": <number>,
    "downside_protection_pct": <number>,
    "investment_thesis": "<string>",
    "key_risks": ["<string>", "<string>", "<string>"],
    "key_catalysts": ["<string>", "<string>", "<string>"]
  }
}`;
}

module.exports = { dealAnalysisPrompt };
