'use strict';

const { OFactorResponseSchema } = require('../../utils/constants');

const WRITING_RULES = `
WRITING RULES — mandatory for ALL text, insight, and takeaway fields:
1. NO VAGUE TIME REFERENCES: Replace "previous quarter", "last year", "recently", "last period" etc. with the specific quarter label from the data (e.g., "Q3 FY26", "Q2 FY25–Q3 FY26"). Write "latest available quarter" only when the exact quarter is genuinely unknown.
2. BACK EVERY CLAIM WITH DATA: Follow every qualitative assertion with a supporting metric in parentheses immediately after the claim. E.g., "pricing power intact (realisation per unit up 8% YoY in Q3 FY26 despite flat volumes)". Remove any claim that cannot be supported by a specific number.
3. USER-FRIENDLY LANGUAGE: Write for a knowledgeable but non-specialist investor. Avoid standalone jargon. When using a technical abbreviation for the first time in a field, add a brief plain-English note — e.g., "EPS CAGR (earnings growth per share, annualised)" or "Porter's score (competitive strength out of 10)".
4. METRICS FIELDS — DATA ONLY: metric.value, metric.change, metric.sublabel must contain ONLY hard numbers, labels, or brief factual descriptions (≤8 words). No interpretation or editorializing inside metric fields — save that for text/insight/takeaway fields.
5. TAKEAWAY FIELD: Write 3–4 sentences — cover what happened (with a specific number), why it matters for investors, any key risk or nuance, and a forward-looking implication. Plain English throughout. 50–80 words total.`;

const DEFAULT_INSTRUCTIONS = `From ALL transcripts (subject + peer), identify:
  • Are companies able to pass through cost increases, or is pricing under pressure?
  • Is competitive intensity rising or consolidating?
  • Is the subject company winning or losing market share?
  • What are the key entry barriers and competitive moats?
Populate with short and crisp points.

Output length guidelines:
  • text.takeaway — 3–4 sentences covering the key fact (with a number), investor significance, any nuance, and forward outlook. 50–80 words total.
  • text.pricing_power_dynamics.current_state, .watch_outs, .future_trajectory, .shifting_dynamics — 20 words max each; include a metric or example
  • text.competitive_positioning.strengths, .opportunities, .areas_to_monitor — 20 words max per item; cite evidence from transcript or data`;

const METRICS = [
  { name: 'Subject EPS CAGR', type: 'computed' },
  { name: 'Subject P/E CAGR', type: 'computed' },
  { name: 'Industry EPS CAGR', type: 'computed' },
  { name: 'Industry P/E CAGR', type: 'computed' },
  { name: 'Entities (segments, products, geography, customers, suppliers)', type: 'qualitative' },
  { name: 'Management milestones (financial targets, guidance, achieved/missed)', type: 'qualitative' },
  { name: 'Current quarter KPIs', type: 'qualitative' },
  { name: 'Governance signals', type: 'qualitative' },
  { name: 'High-severity risks', type: 'qualitative' },
  { name: 'Management tone', type: 'qualitative' },
];

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'N/A';
  const note = obj.type === 'latest_value'
    ? ' (latest value)'
    : ` (${obj.type}${obj.spanYears ? ', ' + obj.spanYears + 'Y' : ''})`;
  return `${obj.value}%` + note;
}

/**
 * Serialize competition-relevant fields from a summaryNew row.
 */
function serializeCompetitionData(row) {
  if (!row) return '(No data available)';
  const { callId, entities, milestones, kpis, governanceSignals, riskDisclosures, tone } = row;
  const parts = [`[Call: ${callId}]`];

  // Entities
  if (entities) {
    const e = entities;
    if (e.company_name)                parts.push(`Company: ${e.company_name}`);
    if (e.business_segments?.length)   parts.push(`Segments: ${e.business_segments.join(', ')}`);
    if (e.key_products?.length)        parts.push(`Key Products: ${e.key_products.join(', ')}`);
    if (e.geographic_presence?.length) parts.push(`Geography: ${e.geographic_presence.join(', ')}`);
    if (e.key_customers?.length)       parts.push(`Key Customers: ${e.key_customers.join(', ')}`);
    if (e.key_suppliers?.length)       parts.push(`Key Suppliers: ${e.key_suppliers.join(', ')}`);
  }

  // Milestones (guidance)
  if (milestones) {
    const m = milestones;
    const financialGoals  = m.future_goals?.financial_targets  ?? [];
    const conceptualGoals = m.future_goals?.conceptual_targets ?? [];
    if (financialGoals.length > 0) {
      parts.push('Management Financial Targets:');
      financialGoals.forEach(g =>
        parts.push(`  • ${g.statement}${g.targeted_value ? ` [target ${g.kpi_abbr ?? ''}=${g.targeted_value}, by ${g.target_time ?? 'TBD'}]` : ''}`)
      );
    }
    if (conceptualGoals.length > 0) {
      parts.push('Management Conceptual Guidance:');
      conceptualGoals.forEach(g =>
        parts.push(`  • ${g.statement}${g.target_time ? ` (by ${g.target_time})` : ''}`)
      );
    }
    const successFin = m.success_disclosures?.financial_targets  ?? [];
    const successCon = m.success_disclosures?.conceptual_targets ?? [];
    if (successFin.length + successCon.length > 0) {
      parts.push('Achieved Milestones:');
      [...successFin, ...successCon].forEach(g =>
        parts.push(`  ✓ ${g.statement ?? g.kpi_abbr}${g.current_value != null ? ` [actual=${g.current_value}]` : ''}`)
      );
    }
    const failureFin = m.failure_disclosures?.financial_targets  ?? [];
    const failureCon = m.failure_disclosures?.conceptual_targets ?? [];
    if (failureFin.length + failureCon.length > 0) {
      parts.push('Missed Milestones:');
      [...failureFin, ...failureCon].forEach(g => parts.push(`  ✗ ${g.statement ?? g.kpi_abbr}`));
    }
  }

  // KPIs
  if (Array.isArray(kpis) && kpis.length > 0) {
    const withValues = kpis.filter(k => k.value != null);
    if (withValues.length > 0)
      parts.push(`Current Quarter KPIs: ${withValues.map(k => `${k.kpi_abbr}=${k.value}`).join(', ')}`);
  }

  // Governance signals
  if (governanceSignals?.defensive_language) {
    parts.push('Governance: defensive language detected');
  }

  // High-severity risks
  if (riskDisclosures?.length) {
    const highRisks = riskDisclosures.filter(r => r.severity === 'high');
    if (highRisks.length > 0) {
      parts.push('High-Severity Risks:');
      highRisks.forEach(r => parts.push(`  ⚠ ${r.risk}`));
    }
  }

  if (tone) parts.push(`Tone: ${tone}`);

  return parts.join('\n');
}

/**
 * @param {string} subjectTicker
 * @param {string} industry
 * @param {{ callId, entities, milestones, kpis, governanceSignals, riskDisclosures, tone }[]} subjectData
 * @param {{ callId, entities, milestones, kpis, governanceSignals, riskDisclosures, tone }[]} peerData
 * @param {{ stockEps, stockPe, industryEps, industryPe }} computedMetrics
 */
function competitionPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics, customInstructions) {
  const { stockEps, stockPe, industryEps, industryPe } = computedMetrics;
  const peerTickers = [...new Set(peerData.map(r => r.callId.split('_FY')[0]).filter(Boolean))];

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeCompetitionData(r)).join('\n\n---\n\n')
    : '(No subject data available)';

  const peerText = peerData.length > 0
    ? peerData.map(r => serializeCompetitionData(r)).join('\n\n---\n\n')
    : '(No peer data available)';

  const indEpsLine = `${fmtCagr(industryEps)}${industryEps?.validTickerCount != null ? ` [${industryEps.validTickerCount}/${industryEps.tickerCount} tickers]` : ''}`;
  const indPeLine  = `${fmtCagr(industryPe)}${industryPe?.avgLatestPe != null ? ` (avg latest P/E: ${industryPe.avgLatestPe})` : ''}`;

  const schemaString = JSON.stringify({ competition: OFactorResponseSchema.competition }, null, 2);

  return `You are a senior equity research analyst. Analyze the competitive dynamics for ${subjectTicker} in the ${industry} industry.

SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}
PEER COMPANIES  : ${peerTickers.length > 0 ? peerTickers.join(', ') : 'N/A'}

══════════════════════════════════════════════════════════
A. PRE-COMPUTED FINANCIAL METRICS (use these directly)
══════════════════════════════════════════════════════════

  Subject ${subjectTicker}
    EPS CAGR  : ${fmtCagr(stockEps)}${stockEps?.firstValue != null ? ` (${stockEps.firstValue} → ${stockEps.latestValue} over ${stockEps.spanYears}Y)` : ''}
    P/E CAGR  : ${fmtCagr(stockPe)}${stockPe?.latestPe != null ? ` (latest P/E: ${stockPe.latestPe}, avg: ${stockPe.avgPe})` : ''}

  Industry
    EPS CAGR  : ${indEpsLine}
    P/E CAGR  : ${indPeLine}

══════════════════════════════════════════════════════════
B. TRANSCRIPT COMMENTARY (entities, milestones, KPIs, risks)
══════════════════════════════════════════════════════════

### SUBJECT — ${subjectTicker}
${subjectText}

### PEERS
${peerText}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

${customInstructions ?? DEFAULT_INSTRUCTIONS}
${WRITING_RULES}

Populate the "final_scoring" field INSIDE the competition JSON object (same level as "metrics"). Award 1 point per check, max 10:
  1. Porter's score ≥ 7/10 → metrics.porters_score
  2. Pricing power is "High" → metrics.pricing_power
  3. Entry barriers are "High" → metrics.entry_barriers
  4. Competitive intensity is "Low" → metrics.competitive_intensity
  5. Clear moat identified (IP / brand / switching costs / network effects) → text.competitive_positioning.strengths
  6. No major disruption threat in the near term → text.competitive_positioning.areas_to_monitor
  7. Subject company gaining or holding market share → based on EPS/PE CAGR vs industry
  8. Subject EPS CAGR > Industry EPS CAGR → computed metrics above
  9. Pricing power dynamics are stable or improving → text.pricing_power_dynamics.future_trajectory
  10. Competitive advantages sustainable 3+ years → text.competitive_positioning.strengths
  status: score >= 7 → "STRONG POSITION" (green), score 5–6 → "MODERATE POSITION" (yellow), score < 5 → "WEAK POSITION" (red).

══════════════════════════════════════════════════════════
D. OUTPUT FORMAT
══════════════════════════════════════════════════════════

Return ONLY valid JSON in EXACTLY the structure below.
Replace ALL placeholder values with your actual analysis. Use null where data is unavailable.
Do NOT include any text, explanation, or markdown fences outside the JSON object.

${schemaString}`;
}

module.exports = { competitionPrompt, DEFAULT_INSTRUCTIONS, METRICS };
