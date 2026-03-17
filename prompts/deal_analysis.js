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
 * @param {Array}   recentSummaries      - Array of Summary objects (milestones, governanceSignals, financialStrength, tone, confidence)
 * @param {object}  stockRev             - { value, type, spanYears, periodsUsed, latestValue, firstValue }
 * @param {object}  stockRoce            - { value, type, period }
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
  recentSummaries = [],
  stockRev = null,
  stockRoce = null,
  ebitMargin = null,         // latest EBIT margin % (derived from kpi_values)
  roe = null,                // latest ROE % (derived from kpi_values)
  cashConversionPct = null,  // FCF/PAT % (derived from kpi_values)
  industryRev = null         // industry Revenue CAGR object { value, type, tickerCount }
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

  const companyEpsCagr  = stockEps?.value         ?? null;
  const companyRevCagr  = stockRev?.value          ?? null;
  const companyRoce     = stockRoce?.value         ?? null;
  const companyEbitMargin      = ebitMargin        ?? null;
  const companyRoe             = roe               ?? null;
  const companyCashConversion  = cashConversionPct ?? null;
  const industryRevCagrVal     = industryRev?.value ?? null;

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

  // Execution alpha: how much the company's EPS growth exceeds industry (ratio)
  const execAlphaRatio = (companyEpsCagr != null && industryEps?.value != null && industryEps.value > 0)
    ? parseFloat((companyEpsCagr / industryEps.value).toFixed(1))
    : null;

  // ── Management context from summaries ──────────────────────────────────────
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

    // Derive a management quality score 0-10 from governance signals
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

  // ── Prompt body ────────────────────────────────────────────────────────────
  return `You are a senior quantitative equity analyst specializing in Indian listed equities. Your task is to produce a rigorous Bear / Base / Bull scenario analysis for the following stock, along with a detailed earnings quality and valuation analysis.

## Company Context
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

## Your Task

### Part 1: Scenario Framework
Generate three scenarios — Bear, Base, and Bull — each with a specific EPS CAGR assumption for the next 3 years. For each scenario:
1. **EPS CAGR** — choose a realistic annualized EPS growth rate
2. **Forward EPS** — compute: annualized_eps_run_rate × (1 + eps_cagr/100)^3
3. **Exit P/E range** — anchor to current P/E (${currentPe}x), historical avg P/E (${avgHistoricalPe}x), industry avg P/E (${industryAvgPe}x). The spread between exit_pe_low and exit_pe_high must not exceed 15% of exit_pe_low (e.g. if low=35, high must be ≤40.25)
4. **Target Price Range** — forward_eps × exit_pe_low and forward_eps × exit_pe_high
5. **Upside/Downside %** — relative to CMP ₹${displayCmp}
6. **CAGR p.a.** — annualized return from CMP to midpoint of target range over 3 years
7. **Probability** — assign probabilities that SUM TO EXACTLY 100%
8. **Key Drivers** — 3-4 concise bullet points per scenario

Also generate a **risk_reward_summary** with probability_weighted_return_pct, risk_reward_ratio, downside_protection_pct, investment_thesis, key_risks (3-4 items), and key_catalysts (3-4 items).

### Part 2: Detailed Analysis
Generate a **detailed_analysis** object with 4 sub-sections:

#### A. eps_engine — Earnings Trajectory
For each scenario (bear/base/bull) provide:
- industry_cagr: assumed industry EPS CAGR in this scenario (bear=lower than historical, base=near historical, bull=higher)
- revenue_growth: assumed company revenue growth; include mgmt_guidance (the stated revenue guidance range from earnings calls, e.g. "15-20%") and mgmt_result (what happens in this scenario)
- margin_trajectory: margin change in bps or %; include mgmt_guidance (stated margin/OPM target) and mgmt_result (actual margin outcome in this scenario)
- execution_alpha: rating is the management quality score (${managementScore != null ? `${managementScore}/10` : 'compute from governance signals'}), value is 0.5x/1.0x/1.3x for bear/base/bull, note is Underperform/Meet/Exceed guidance
- expected_eps_cagr: must match the eps_cagr_pct from scenario_framework
Also write a 2-3 sentence insight explaining the earnings trajectory logic.

#### B. historical_performance — Company vs Industry EPS Growth
- company_growth: company 5yr EPS CAGR (${companyEpsCagr != null ? `${companyEpsCagr}%` : 'compute from available data'})
- industry_growth: industry 5yr EPS CAGR (${industryEps?.value != null ? `${industryEps.value}%` : 'estimate'})
- chart_data: generate 5-6 years of annual data with company and industry EPS growth % per year. Use your training knowledge for historical financials, anchored to the CAGR values above. Include FY20-FY25E labels.
- stats: 3 computed stats — avg outperformance vs industry, consistency (e.g. "6/6 yrs"), latest year growth

#### C. quality_of_earnings — Atomic Metrics
- metrics: 4 metric cards using the values provided above:
  - EBITDA MARGIN: use EBIT Margin of ${companyEbitMargin != null ? `${companyEbitMargin}%` : 'N/A (estimate from industry knowledge)'}; compute change vs historical average
  - RETURN ON EQUITY: use ROE of ${companyRoe != null ? `${companyRoe}%` : 'N/A (estimate from industry knowledge)'}; compute change vs historical average
  - MARKET SHARE: estimate from industry knowledge if not directly available
  - CASH CONVERSION: use ${companyCashConversion != null ? `${companyCashConversion}% (FCF/PAT)` : 'N/A (estimate from industry knowledge)'}
- chart_data: generate 5-6 years of ROE, ROIC (estimate as ROCE proxy), and market_share trend. Anchor ROE to ${companyRoe != null ? `${companyRoe}%` : 'N/A'}, ROIC to ROCE of ${companyRoce != null ? `${companyRoce}%` : 'N/A'}.
- bottom_line: 2-3 sentence earnings quality summary citing specific metrics

#### D. valuation_vs_peers — Valuation Context
- current_position: 4 comparison cards using the values provided above:
  - P/E MULTIPLE: use current P/E=${currentPe ?? 'N/A'}x vs industry avg P/E=${industryAvgPe ?? 'N/A'}x; show pct premium/discount
  - EV/EBITDA: estimate from industry knowledge anchored to EBIT Margin of ${companyEbitMargin != null ? `${companyEbitMargin}%` : 'N/A'}
  - ROE QUALITY: use company ROE=${companyRoe != null ? `${companyRoe}%` : 'N/A'} vs industry estimate; show premium/discount
  - GROWTH RATE: use company Revenue CAGR=${companyRevCagr != null ? `${companyRevCagr}%` : 'N/A'} vs industry Revenue CAGR=${industryRevCagrVal != null ? `${industryRevCagrVal}%` : 'N/A'}; show premium/discount
- re_rating_view: badge (EXPAND/SUSTAIN/CONTRACT based on base case), title, and description with bear/base/bull P/E multiples embedded as rich text array with {text, bold?, color?} parts
- expansion_drivers: 4 items with text (bold label) and detail (brief qualifier)
- contraction_risks: 4 items with text and detail
- scenario_multiples: 3 rows for bull/base/bear exit P/E with label, value, change description, and color

---

## Output Format

Return ONLY a valid JSON object. No markdown fences, no explanation:

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
  },
  "detailed_analysis": {
    "eps_engine": {
      "meta": {
        "section_id": "eps_engine",
        "title": "Earnings Trajectory & Quality",
        "subtitle": "How earnings are growing and whether they're high quality"
      },
      "sub_section_title": "EPS ENGINE: WHAT DRIVES EARNINGS IN EACH SCENARIO",
      "sub_section_subtitle": "<string>",
      "scenarios": {
        "bear": {
          "industry_cagr":     { "value": "<string e.g. 3.5%>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string e.g. -100bps>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string e.g. 8.4/10>", "value": "0.5x", "note": "Underperform" },
          "expected_eps_cagr": { "value": "<string — must match bear eps_cagr_pct>", "subtitle": "<string>" }
        },
        "base": {
          "industry_cagr":     { "value": "<string>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string>", "value": "1.0x", "note": "Meet guidance" },
          "expected_eps_cagr": { "value": "<string — must match base eps_cagr_pct>", "subtitle": "<string>" }
        },
        "bull": {
          "industry_cagr":     { "value": "<string>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string>", "value": "1.3x", "note": "Exceed guidance" },
          "expected_eps_cagr": { "value": "<string — must match bull eps_cagr_pct>", "subtitle": "<string>" }
        }
      },
      "insight": "<string: 2-3 sentences explaining the EPS engine logic>"
    },
    "historical_performance": {
      "meta": {
        "section_id": "historical_performance",
        "title": "Historical Performance: Company EPS CAGR vs Industry Earnings Growth",
        "subtitle": "<string>"
      },
      "company_growth":  { "value": "<string e.g. 24.2%>", "label": "5 yr CAGR" },
      "industry_growth": { "value": "<string>", "label": "5 yr CAGR" },
      "company_name":  "${companyName}",
      "industry_name": "${industry}",
      "chart_data": [
        { "year": "FY20",  "company": <number>, "industry": <number> },
        { "year": "FY21",  "company": <number>, "industry": <number> },
        { "year": "FY22",  "company": <number>, "industry": <number> },
        { "year": "FY23",  "company": <number>, "industry": <number> },
        { "year": "FY24",  "company": <number>, "industry": <number> },
        { "year": "FY25E", "company": <number>, "industry": <number> }
      ],
      "stats": [
        { "value": "<string>", "label": "Avg outperformance vs industry", "color": "emerald" },
        { "value": "<string>", "label": "Beat industry X/6 years",        "color": "blue" },
        { "value": "<string>", "label": "Latest year growth",             "color": "purple" }
      ]
    },
    "quality_of_earnings": {
      "meta": {
        "section_id": "quality_of_earnings",
        "title": "Quality of Earnings: Atomic Metrics",
        "subtitle": "<string>"
      },
      "metrics": [
        { "label": "EBITDA MARGIN",    "value": "<string>", "change": "<string e.g. +390 bps (FY20→FY24)>", "change_color": "emerald" },
        { "label": "RETURN ON EQUITY", "value": "<string>", "change": "<string>", "change_color": "blue" },
        { "label": "MARKET SHARE",     "value": "<string|N/A>", "change": "<string>", "change_color": "purple" },
        { "label": "CASH CONVERSION",  "value": "<string e.g. 88%>", "change": "<string>", "change_color": "amber" }
      ],
      "chart_data": [
        { "year": "FY20",  "roe": <number>, "roic": <number>, "market_share": <number> },
        { "year": "FY21",  "roe": <number>, "roic": <number>, "market_share": <number> },
        { "year": "FY22",  "roe": <number>, "roic": <number>, "market_share": <number> },
        { "year": "FY23",  "roe": <number>, "roic": <number>, "market_share": <number> },
        { "year": "FY24",  "roe": <number>, "roic": <number>, "market_share": <number> },
        { "year": "FY25E", "roe": <number>, "roic": <number>, "market_share": <number> }
      ],
      "bottom_line": "<string: 2-3 sentences on earnings quality>"
    },
    "valuation_vs_peers": {
      "meta": {
        "section_id": "valuation_vs_peers",
        "title": "Valuation vs Peers",
        "subtitle": "<string>"
      },
      "current_position": [
        { "label": "P/E MULTIPLE", "value": "<string e.g. +38%>", "detail": "<string e.g. 32.4x vs 23.5x>", "color": "amber" },
        { "label": "EV/EBITDA",    "value": "<string>", "detail": "<string>", "color": "amber" },
        { "label": "ROE QUALITY",  "value": "<string>", "detail": "<string>", "color": "emerald" },
        { "label": "GROWTH RATE",  "value": "<string>", "detail": "<string>", "color": "emerald" }
      ],
      "re_rating_view": {
        "badge": "<EXPAND|SUSTAIN|CONTRACT>",
        "title": "<string>",
        "description": [
          { "text": "<string>" },
          { "text": "<string>", "bold": true },
          { "text": "<string>" }
        ]
      },
      "expansion_drivers": [
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" }
      ],
      "contraction_risks": [
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" },
        { "text": "<string label>:", "detail": "<string qualifier>" }
      ],
      "scenario_multiples": [
        { "label": "Bull Case Exit P/E", "value": "<string>", "change": "<string>", "color": "emerald" },
        { "label": "Base Case Exit P/E", "value": "<string>", "change": "<string>", "color": "blue" },
        { "label": "Bear Case Exit P/E", "value": "<string>", "change": "<string>", "color": "red" }
      ]
    }
  }
}`;
}

module.exports = { dealAnalysisPrompt };
