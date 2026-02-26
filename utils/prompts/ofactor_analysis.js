const { OFactorResponseSchema } = require('../constants');

// ─── Fincrux Data Serialization ──────────────────────────────────────────────

/**
 * Extract a time-series map { "Mar 2022": "123.4", ... } for each requested
 * metric from a fincrux 2-D table (profit_and_loss, ratios, balance_sheet, etc.)
 */
function extractTimeSeries(table, metricNames) {
  if (!table || table.length < 2) return {};

  const headers = table[0]; // ["Category", "Mar 2020", "Mar 2021", ...]
  const years   = headers.slice(1);

  const result = {};
  for (const name of metricNames) {
    const row = table.find(r => r[0] === name);
    if (!row) continue;

    const series = {};
    years.forEach((year, idx) => {
      if (year && year !== 'TTM') {
        const val = row[idx + 1];
        if (val !== null && val !== undefined && val !== '') {
          series[year] = val;
        }
      }
    });
    if (Object.keys(series).length > 0) result[name] = series;
  }
  return result;
}

/**
 * Serialize a single ticker's fincrux result into a compact text block.
 */
function serializeFinancialData(tickerResult) {
  if (!tickerResult) return '[No data]';
  if (tickerResult.error) return `[Data unavailable: ${tickerResult.error}]`;

  const { data, company, ticker } = tickerResult;
  if (!data) return `[Empty data for ${ticker}]`;

  const lines = [`Company: ${company || ticker} (${ticker})`];

  // ── Current snapshot ───────────────────────────────────────────────────────
  if (data.top_ratios) {
    const tr = data.top_ratios;
    const snap = [
      tr['Market Cap']     ? `Market Cap: ${tr['Market Cap']}`      : null,
      tr['Stock P/E']      ? `P/E: ${tr['Stock P/E']}`              : null,
      tr['ROCE']           ? `ROCE: ${tr['ROCE']}`                  : null,
      tr['ROE']            ? `ROE: ${tr['ROE']}`                    : null,
      tr['Dividend Yield'] ? `Div Yield: ${tr['Dividend Yield']}`   : null,
      tr['Book Value']     ? `Book Value: ${tr['Book Value']}`       : null,
    ].filter(Boolean).join(' | ');
    if (snap) lines.push(`Current Snapshot: ${snap}`);
  }

  // ── P&L ────────────────────────────────────────────────────────────────────
  const plSeries = extractTimeSeries(data.profit_and_loss, [
    'Sales', 'Operating Profit', 'OPM %',
    'Net Profit', 'EPS in Rs', 'Depreciation', 'Interest',
  ]);
  if (Object.keys(plSeries).length > 0) {
    lines.push('P&L (Annual):');
    for (const [metric, series] of Object.entries(plSeries)) {
      lines.push(`  ${metric}: ${Object.entries(series).map(([yr, v]) => `${yr}:${v}`).join('  ')}`);
    }
  }

  // ── Ratios ─────────────────────────────────────────────────────────────────
  const ratioSeries = extractTimeSeries(data.ratios, [
    'ROCE %', 'ROE %', 'Debtor Days', 'Working Capital Days', 'Cash Conversion Cycle',
  ]);
  if (Object.keys(ratioSeries).length > 0) {
    lines.push('Ratios (Annual):');
    for (const [metric, series] of Object.entries(ratioSeries)) {
      lines.push(`  ${metric}: ${Object.entries(series).map(([yr, v]) => `${yr}:${v}`).join('  ')}`);
    }
  }

  // ── Balance sheet ──────────────────────────────────────────────────────────
  const bsSeries = extractTimeSeries(data.balance_sheet, [
    'Borrowings', 'Total Assets', 'Reserves', 'Equity Capital',
  ]);
  if (Object.keys(bsSeries).length > 0) {
    lines.push('Balance Sheet (Annual):');
    for (const [metric, series] of Object.entries(bsSeries)) {
      lines.push(`  ${metric}: ${Object.entries(series).map(([yr, v]) => `${yr}:${v}`).join('  ')}`);
    }
  }

  // ── Cash flows ─────────────────────────────────────────────────────────────
  const cfSource = data.cash_flows || data.profit_and_loss;
  const cfSeries = extractTimeSeries(cfSource, [
    'Cash from Operating Activity',
    'Cash from Investing Activity',
    'Cash from Financing Activity',
    'Net Cash Flow',
  ]);
  if (Object.keys(cfSeries).length > 0) {
    lines.push('Cash Flows (Annual):');
    for (const [metric, series] of Object.entries(cfSeries)) {
      lines.push(`  ${metric}: ${Object.entries(series).map(([yr, v]) => `${yr}:${v}`).join('  ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Summary Serialization ────────────────────────────────────────────────────

/**
 * Fully serialize one Summary DB row — entities, kpis, milestones, industryAnalysis.
 */
function serializeSummary(summary) {
  if (!summary) return 'No transcript data available.';

  const parts = [`[Call: ${summary.callId}]`];

  // ── Entities (business profile) ───────────────────────────────────────────
  if (summary.entities) {
    const e = summary.entities;
    if (e.company_name)                parts.push(`Company: ${e.company_name}`);
    if (e.business_segments?.length)   parts.push(`Segments: ${e.business_segments.join(', ')}`);
    if (e.key_products?.length)        parts.push(`Key Products: ${e.key_products.join(', ')}`);
    if (e.geographic_presence?.length) parts.push(`Geography: ${e.geographic_presence.join(', ')}`);
    if (e.key_customers?.length)       parts.push(`Key Customers: ${e.key_customers.join(', ')}`);
    if (e.key_suppliers?.length)       parts.push(`Key Suppliers: ${e.key_suppliers.join(', ')}`);
  }

  // ── KPIs (quantitative values from quarterly earnings) ────────────────────
  if (Array.isArray(summary.kpis) && summary.kpis.length > 0) {
    parts.push('KPI Values (from QE extraction):');
    summary.kpis
      .filter(k => k.value !== null && k.value !== undefined)
      .forEach(k => parts.push(`  ${k.kpi_abbr}: ${k.value}`));
  }

  // ── Milestones (future goals + success/failure disclosures) ───────────────
  if (summary.milestones) {
    const m = summary.milestones;

    const financialGoals = m.future_goals?.financial_targets ?? [];
    if (financialGoals.length > 0) {
      parts.push('Management Financial Targets (forward guidance):');
      financialGoals.forEach(g =>
        parts.push(`  • ${g.statement}${g.targeted_value ? ` [target ${g.kpi_abbr ?? ''}=${g.targeted_value}, by ${g.target_time ?? 'TBD'}]` : ''}`)
      );
    }

    const conceptualGoals = m.future_goals?.conceptual_targets ?? [];
    if (conceptualGoals.length > 0) {
      parts.push('Management Conceptual Guidance:');
      conceptualGoals.forEach(g =>
        parts.push(`  • ${g.statement}${g.target_time ? ` (by ${g.target_time})` : ''}`)
      );
    }

    const successFin  = m.success_disclosures?.financial_targets  ?? [];
    const successCon  = m.success_disclosures?.conceptual_targets ?? [];
    const failureFin  = m.failure_disclosures?.financial_targets  ?? [];
    const failureCon  = m.failure_disclosures?.conceptual_targets ?? [];

    if (successFin.length + successCon.length > 0) {
      parts.push('Achieved / Confirmed Milestones:');
      [...successFin, ...successCon].forEach(g =>
        parts.push(`  ✓ ${g.statement ?? g.kpi_abbr}${g.current_value != null ? ` [actual=${g.current_value}]` : ''}`)
      );
    }

    if (failureFin.length + failureCon.length > 0) {
      parts.push('Missed / Failed Milestones:');
      [...failureFin, ...failureCon].forEach(g =>
        parts.push(`  ✗ ${g.statement ?? g.kpi_abbr}`)
      );
    }
  }

  // ── Industry Analysis (sector-level commentary from transcript) ───────────
  if (summary.industryAnalysis) {
    const ia = summary.industryAnalysis;
    parts.push('Industry Analysis (from transcript):');
    if (ia.industry)                     parts.push(`  Sector: ${ia.industry}`);
    if (ia.market_size)                  parts.push(`  Market Size: ${ia.market_size}`);
    if (ia.growth_drivers?.length)       parts.push(`  Growth Drivers: ${ia.growth_drivers.join('; ')}`);
    if (ia.headwinds?.length)            parts.push(`  Headwinds: ${ia.headwinds.join('; ')}`);
    if (ia.capacity_utilization)         parts.push(`  Capacity Utilization: ${ia.capacity_utilization}`);
    if (ia.competitive_position)         parts.push(`  Competitive Position: ${ia.competitive_position}`);
    if (ia.order_book_commentary)        parts.push(`  Order Book: ${ia.order_book_commentary}`);
    if (ia.capex_cycle)                  parts.push(`  Capex Cycle: ${ia.capex_cycle}`);
    if (ia.pricing_environment)          parts.push(`  Pricing Environment: ${ia.pricing_environment}`);
    if (ia.supply_demand_commentary)     parts.push(`  Supply/Demand: ${ia.supply_demand_commentary}`);
    if (ia.regulatory_environment)       parts.push(`  Regulatory: ${ia.regulatory_environment}`);
    // Dump any remaining unknown keys
    const knownKeys = new Set([
      'industry','market_size','growth_drivers','headwinds','capacity_utilization',
      'competitive_position','order_book_commentary','capex_cycle','pricing_environment',
      'supply_demand_commentary','regulatory_environment'
    ]);
    for (const [k, v] of Object.entries(ia)) {
      if (!knownKeys.has(k) && v !== null && v !== undefined) {
        parts.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    }
  }

  // ── Governance ────────────────────────────────────────────────────────────
  if (summary.governanceSignals) {
    const gs = summary.governanceSignals;
    const flags = [];
    if (gs.transparent)                flags.push('transparent');
    if (gs.capital_allocation_clarity) flags.push('clear capital allocation');
    if (gs.defensive_language)         flags.push('defensive language');
    if (flags.length)                  parts.push(`Governance Signals: ${flags.join(', ')}`);
  }

  if (summary.tone)       parts.push(`Tone: ${summary.tone}`);
  if (summary.confidence) parts.push(`Confidence: ${summary.confidence}`);

  return parts.join('\n');
}

// ─── Main Prompt ──────────────────────────────────────────────────────────────

/**
 * Build the full OFactor analysis prompt.
 *
 * @param {string} subjectTicker        - e.g. "ADANIENSOL"
 * @param {string} subjectCompanyName   - e.g. "Adani Energy Solutions Ltd"
 * @param {string} industry             - e.g. "Integrated Power Utilities"
 * @param {Array}  allFinancialData     - Output of fetchMultipleTickerFinancials([subject, ...peers])
 * @param {Array}  subjectSummaries     - Up to 3 Summary rows for subject (oldest→newest)
 * @param {Array}  peerSummaries        - 3 latest Summary rows across all peers (by createdAt desc)
 */
function oFactorAnalysisPrompt(
  subjectTicker,
  subjectCompanyName,
  industry,
  allFinancialData,
  subjectSummaries,
  peerSummaries
) {
  const peerTickers = [...new Set(
    peerSummaries.map(s => s.callId.split('_FY')[0]).filter(Boolean)
  )];

  // ── Financial data ─────────────────────────────────────────────────────────
  const subjectFinData  = allFinancialData.find(r => r.ticker === subjectTicker);
  const peerFinDataList = allFinancialData.filter(r => r.ticker !== subjectTicker);

  const subjectFinText = serializeFinancialData(subjectFinData);
  const peerFinText    = peerFinDataList.length > 0
    ? peerFinDataList.map(r => `--- ${r.ticker} ---\n${serializeFinancialData(r)}`).join('\n\n')
    : '(No peer financial data available)';

  // ── Subject transcript summaries ───────────────────────────────────────────
  const subjectTranscriptText = subjectSummaries.length > 0
    ? subjectSummaries.map(s => `\n${serializeSummary(s)}`).join('\n\n---\n')
    : '(No transcript summaries available for subject company)';

  // ── Peer transcript summaries (3 latest across all peers) ─────────────────
  const peerTranscriptText = peerSummaries.length > 0
    ? peerSummaries.map(s => `\n${serializeSummary(s)}`).join('\n\n---\n')
    : '(No peer transcript summaries available)';

  const schemaString = JSON.stringify(OFactorResponseSchema, null, 2);

  return `You are a senior equity research analyst producing an Opportunity Factor (OFactor) report for a potential investment.
Synthesise the quantitative financial data (Screener/Fincrux annual time-series) and qualitative signals (earnings call transcript summaries) provided below to fill all four sections of the output JSON.

SUBJECT COMPANY : ${subjectTicker} | ${subjectCompanyName}
INDUSTRY        : ${industry}
PEER COMPANIES  : ${peerTickers.length > 0 ? peerTickers.join(', ') : 'N/A'}

══════════════════════════════════════════════════════════
A. FINANCIAL DATA (ANNUAL TIME-SERIES, INR Crores unless noted)
══════════════════════════════════════════════════════════

### SUBJECT: ${subjectTicker}
${subjectFinText}

### PEERS
${peerFinText}

══════════════════════════════════════════════════════════
B. TRANSCRIPT & MANAGEMENT COMMENTARY
Each block contains: entities · KPI values · milestones (guidance given / achieved / missed)
· industry analysis · governance signals — all extracted from earnings call summaries.
══════════════════════════════════════════════════════════

### SUBJECT TRANSCRIPTS — ${subjectTicker} (up to 3 calls, chronological oldest→newest)
${subjectTranscriptText}

### PEER TRANSCRIPTS — 3 most recent calls across all peers
${peerTranscriptText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
Analyse the data above and populate each of the four JSON sections below.
══════════════════════════════════════════════════════════

### 4.1 — INDUSTRY OVERVIEW & MARKET
Use financials of ALL available companies (subject + peers) to assess revenue growth trends,
operating margins, EBITDA margins, and capacity utilisation — derive industry averages and
directional trends across available years.
From ALL transcripts (subject + peer), identify:
  • Are the majority of managements talking about volume growth?
  • Are order books or pipelines expanding?
  • Is management guidance on volumes and capex positive or cautious?
Populate the "industry_overview" section. For industry_transcripts, use real paraphrased or
verbatim quotes from the transcript data above, attributing them to the correct company and call.


### 4.2 — COMPETITION
Use financials of ALL companies to benchmark the subject against peers on revenue growth,
operating margins, ROCE, and leverage — note explicitly where it leads, matches, or lags.
From ALL transcripts identify:
  • Are companies able to pass through cost increases, or is pricing under pressure?
  • Is competitive intensity rising or consolidating?
  • Is the subject company winning or losing share?
Populate the "competition" section.

### 4.3 — FINANCIAL STRENGTH
Use the SUBJECT company's financial time-series to assess:
  revenue growth trajectory · margin expansion in bps · FCF conversion quality · balance sheet deleveraging.
From the SUBJECT company's transcripts identify:
  • Is growth volume/mix driven or purely price-led?
  • Is management confident about sustaining margins?
  • Is capital being deployed with discipline (debt targets, capex ROI, shareholder returns)?
Populate the "financial_strength" section.

### 4.4 — CLIENT / CUSTOMER TRACTION
From the SUBJECT company's financials, extract or compute (use null if not available):
  active customer count · NRR · average contract value · churn · gross adds.
From the SUBJECT company's transcripts identify:
  • Is new customer acquisition accelerating or slowing?
  • Are existing customers expanding spend (upsells, larger project scopes)?
  • Are customers deeply embedded via long contracts or multi-product use?
  • Has management referenced any alt data signals (web traffic, app engagement, customer hiring)?
Populate the "customer_traction" section.

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════
Return ONLY a valid JSON object in EXACTLY the structure below.
Only return 3-4 short and crisp points in your analysis for text part of each section
Replace ALL placeholder / example values with your actual analysis derived from the data above.
Where a metric cannot be determined from available data, use null for numeric/value fields or "N/A" for strings.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { oFactorAnalysisPrompt };
