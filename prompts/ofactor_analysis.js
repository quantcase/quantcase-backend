const { OFactorResponseSchema } = require('../utils/constants');

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

  // ── Quarterly KPIs (from QE extraction — actual financial values) ──────────
  if (Array.isArray(summary.kpis) && summary.kpis.length > 0) {
    const qeKpis = summary.kpis.filter(k => k.value !== null && k.value !== undefined);
    if (qeKpis.length > 0)
      parts.push(`Current Quarter KPIs: ${qeKpis.map(k => `${k.kpi_abbr}=${k.value}`).join(', ')}`);
  }

  // ── Industry Analysis (sector-level commentary from transcript) ───────────
  if (summary.industryAnalysis) {
    const ia = summary.industryAnalysis;
    parts.push('Industry Analysis (from transcript):');

    // Transcript-mentioned KPIs with non-null values only
    const transcriptKpis = (ia.kpis ?? []).filter(k => k.value !== null && k.value !== undefined);
    if (transcriptKpis.length > 0)
      parts.push(`  KPIs: ${transcriptKpis.map(k => `${k.kpi_abbr}=${k.value}`).join(', ')}`);

    if (ia.growth_drivers?.length) parts.push(`  Growth Drivers: ${ia.growth_drivers.join('; ')}`);
    if (ia.headwinds?.length)      parts.push(`  Headwinds: ${ia.headwinds.join('; ')}`);
  }

  // ── Governance (high-severity signals only: defensive language) ───────────
  if (summary.governanceSignals?.defensive_language) {
    parts.push('Governance: defensive language detected');
  }

  // ── Risk Disclosures (high severity only) ─────────────────────────────────
  if (summary.riskDisclosures?.length) {
    const highRisks = summary.riskDisclosures.filter(r => r.severity === 'high');
    if (highRisks.length > 0) {
      parts.push('High-Severity Risks:');
      highRisks.forEach(r => parts.push(`  ⚠ ${r.risk}`));
    }
  }

  if (summary.tone)       parts.push(`Tone: ${summary.tone}`);
  if (summary.confidence) parts.push(`Confidence: ${summary.confidence}`);

  return parts.join('\n');
}

// ─── Computed Metrics Serialization ──────────────────────────────────────────

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'N/A';
  const pct = `${obj.value}%`;
  const note = obj.type === 'latest_value' ? ` (latest value, CAGR not computable${obj.note ? ': ' + obj.note : ''})` : ` (${obj.type}, ${obj.spanYears ?? obj.periodsUsed + ' periods'})`;
  return pct + note;
}

/**
 * Serialize pre-computed stock + industry metrics into a concise prompt block.
 */
function serializeComputedMetrics(subjectTicker, stockEps, stockPe, industryEps, industryPe, industryOpm) {
  const lines = ['PRE-COMPUTED FINANCIAL METRICS'];

  lines.push(`\nSubject Stock — ${subjectTicker}`);
  lines.push(`  EPS CAGR  : ${fmtCagr(stockEps)}`);
  if (stockEps?.firstValue != null) lines.push(`    (from ${stockEps.firstValue} → ${stockEps.latestValue} over ${stockEps.spanYears} yrs, ${stockEps.periodsUsed} quarters)`);
  lines.push(`  P/E CAGR  : ${fmtCagr(stockPe)}`);
  if (stockPe?.latestPe  != null) lines.push(`    (latest P/E: ${stockPe.latestPe}, historical avg P/E: ${stockPe.avgPe})`);

  lines.push(`\nIndustry`);
  lines.push(`  EPS CAGR  : ${fmtCagr(industryEps)}${industryEps?.validTickerCount != null ? ` [${industryEps.validTickerCount}/${industryEps.tickerCount} tickers]` : ''}`);
  lines.push(`  P/E CAGR  : ${fmtCagr(industryPe)}${industryPe?.avgLatestPe != null ? ` (avg latest P/E: ${industryPe.avgLatestPe})` : ''}`);
  if (industryOpm?.value != null) {
    lines.push(`  Avg OPM   : ${industryOpm.value}% (via "${industryOpm.abbrUsed}", ${industryOpm.sampleSize} data points)`);
  } else {
    lines.push(`  Avg OPM   : N/A`);
  }

  return lines.join('\n');
}

// ─── Main Prompt ──────────────────────────────────────────────────────────────

/**
 * Build the full OFactor analysis prompt.
 *
 * @param {string} subjectTicker      - e.g. "MOTILALOFS"
 * @param {string} subjectCompanyName - e.g. "Motilal Oswal Financial Services"
 * @param {string} industry           - e.g. "Stockbroking & Allied"
 * @param {Array}  subjectSummaries   - Up to 2 Summary rows for subject (oldest→newest)
 * @param {Array}  peerSummaries      - Latest Summary rows for peer companies
 * @param {object} computedMetrics    - { stockEps, stockPe }
 */
function oFactorAnalysisPrompt(
  subjectTicker,
  subjectCompanyName,
  industry,
  subjectSummaries,
  peerSummaries,
  computedMetrics = {}
) {
  const { stockEps = null, stockPe = null, industryEps = null, industryPe = null, industryOpm = null } = computedMetrics;
  const peerTickers = [...new Set(
    peerSummaries.map(s => s.callId.split('_FY')[0]).filter(Boolean)
  )];

  // ── Subject transcript summaries ───────────────────────────────────────────
  const subjectTranscriptText = subjectSummaries.length > 0
    ? subjectSummaries.map(s => `\n${serializeSummary(s)}`).join('\n\n---\n')
    : '(No transcript summaries available for subject company)';

  // ── Peer transcript summaries ──────────────────────────────────────────────
  const peerTranscriptText = peerSummaries.length > 0
    ? peerSummaries.map(s => `\n${serializeSummary(s)}`).join('\n\n---\n')
    : '(No peer transcript summaries available)';

  const schemaString = JSON.stringify(OFactorResponseSchema, null, 2);

  return `You are a senior equity research analyst producing an Opportunity Factor (OFactor) snapshot for a potential investment.
Synthesise the pre-computed financial metrics and qualitative signals from earnings call transcript summaries provided below to fill all four sections of the output JSON.

SUBJECT COMPANY : ${subjectTicker} | ${subjectCompanyName}
INDUSTRY        : ${industry}
PEER COMPANIES  : ${peerTickers.length > 0 ? peerTickers.join(', ') : 'N/A'}

══════════════════════════════════════════════════════════
A. PRE-COMPUTED METRICS (use these directly — do not re-derive)
══════════════════════════════════════════════════════════

${serializeComputedMetrics(subjectTicker, stockEps, stockPe, industryEps, industryPe, industryOpm)}

══════════════════════════════════════════════════════════
B. TRANSCRIPT & MANAGEMENT COMMENTARY
Each block contains: entities · quarterly KPIs · milestones (guidance given / achieved / missed)
· industry analysis · governance signals — all extracted from earnings call summaries.
══════════════════════════════════════════════════════════

### SUBJECT TRANSCRIPTS — ${subjectTicker}
${subjectTranscriptText}

### PEER TRANSCRIPTS
${peerTranscriptText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
Use the pre-computed metrics in section A and quarterly KPIs in section B as your primary quantitative reference.
Populate each of the four JSON sections below.
══════════════════════════════════════════════════════════

### 4.1 — INDUSTRY OVERVIEW & MARKET
From ALL transcripts (subject + peer), identify:
  • Are the majority of managements talking about volume growth?
  • Are order books or pipelines expanding?
  • Is management guidance on volumes and capex positive or cautious?
Use the quarterly KPIs from subject and peer summaries for any numeric references.
Then populate the section with short and crisp explanations (maximum 10 words each)

### 4.2 — COMPETITION
From ALL transcripts identify:
  • Are companies able to pass through cost increases, or is pricing under pressure?
  • Is competitive intensity rising or consolidating?
  • Is the subject company winning or losing share?
Then populate the section with short and crisp explanations (maximum 10 words each)

### 4.3 — FINANCIAL STRENGTH
Use the pre-computed metrics in section A (stock EPS CAGR, P/E CAGR) and quarterly KPIs from
section B to assess: revenue growth trajectory · margin expansion · FCF conversion · balance sheet.
From the SUBJECT company's transcripts identify:
  • Is growth volume/mix driven or purely price-led?
  • Is management confident about sustaining margins?
  • Is capital being deployed with discipline (debt targets, capex ROI, shareholder returns)?
Then populate the section with short and crisp explanations (maximum 10 words each)

### 4.4 — CLIENT / CUSTOMER TRACTION
From the SUBJECT company's transcripts identify:
  • Is new customer acquisition accelerating or slowing?
  • Are existing customers expanding spend (upsells, larger project scopes)?
  • Are customers deeply embedded via long contracts or multi-product use?
  • Has management referenced any alt data signals (web traffic, app engagement, customer hiring)?
Then populate the section with short and crisp explanations (maximum 10 words each)
══════════════════════════════════════════════════════════
E. OUTPUT FORMAT
══════════════════════════════════════════════════════════
Return ONLY a valid JSON object in EXACTLY the structure below. For metrics, don't change any key name in json object. For example don't do opm --> opm_fy2025
Only return 3-4 short and crisp points in your analysis for text part of each section
Replace ALL placeholder / example values with your actual analysis derived from the data above.
Where a metric cannot be determined from available data, use null for numeric/value fields or "N/A" for strings.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { oFactorAnalysisPrompt };
