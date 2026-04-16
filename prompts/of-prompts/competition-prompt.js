'use strict';

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'N/A';
  const note = obj.type === 'latest_value'
    ? ' (latest value)'
    : ` (${obj.type}${obj.spanYears ? ', ' + obj.spanYears + 'Y' : ''})`;
  return `${obj.value}%` + note;
}

function serializeCompetitionData(row) {
  if (!row) return '(No data available)';
  const { callId, entities, milestones, kpis, governanceSignals, riskDisclosures, tone } = row;
  const parts = [`[Call: ${callId}]`];

  if (entities) {
    const e = entities;
    if (e.company_name)                parts.push(`Company: ${e.company_name}`);
    if (e.business_segments?.length)   parts.push(`Segments: ${e.business_segments.join(', ')}`);
    if (e.key_products?.length)        parts.push(`Key Products: ${e.key_products.join(', ')}`);
    if (e.geographic_presence?.length) parts.push(`Geography: ${e.geographic_presence.join(', ')}`);
    if (e.key_customers?.length)       parts.push(`Key Customers: ${e.key_customers.join(', ')}`);
    if (e.key_suppliers?.length)       parts.push(`Key Suppliers: ${e.key_suppliers.join(', ')}`);
  }

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

  if (Array.isArray(kpis) && kpis.length > 0) {
    const withValues = kpis.filter(k => k.value != null);
    if (withValues.length > 0)
      parts.push(`Current Quarter KPIs: ${withValues.map(k => `${k.kpi_abbr}=${k.value}`).join(', ')}`);
  }

  if (governanceSignals?.defensive_language) {
    parts.push('Governance: defensive language detected');
  }

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


// ─── Data block builder ───────────────────────────────────────────────────────

function buildDataBlock(subjectTicker, industry, subjectData, peerData, computedMetrics) {
  const { stockEps, stockPe, industryEps, industryPe } = computedMetrics;
  const peerTickers = [...new Set(peerData.map(r => r.callId.split('_FY')[0]).filter(Boolean))];

  const _latestCallId = subjectData.length > 0 ? subjectData[subjectData.length - 1].callId : null;
  const _pm = _latestCallId && _latestCallId.match(/_FY(\d{4})_(Q\d)$/i);
  const snapshotPeriod = _pm ? `${_pm[2]} FY${_pm[1].slice(-2)}` : 'latest available';

  const subjectText = subjectData.length > 0
    ? subjectData.map(r => serializeCompetitionData(r)).join('\n\n---\n\n')
    : '(No subject data available)';

  const peerText = peerData.length > 0
    ? peerData.map(r => serializeCompetitionData(r)).join('\n\n---\n\n')
    : '(No peer data available)';

  const indEpsLine = `${fmtCagr(industryEps)}${industryEps?.validTickerCount != null ? ` [${industryEps.validTickerCount}/${industryEps.tickerCount} tickers]` : ''}`;
  const indPeLine  = `${fmtCagr(industryPe)}${industryPe?.avgLatestPe != null ? ` (avg latest P/E: ${industryPe.avgLatestPe})` : ''}`;

  return `SUBJECT COMPANY : ${subjectTicker}
INDUSTRY        : ${industry}
PEER COMPANIES  : ${peerTickers.length > 0 ? peerTickers.join(', ') : 'N/A'}
ANALYSIS PERIOD : ${snapshotPeriod}

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

Period context: Transcript data above reflects ${snapshotPeriod}. Do NOT append or repeat the period label inside metric values, sublabels, or any other output fields.`;
}

// ─── Main exported prompt builder ────────────────────────────────────────────

function competitionPrompt(subjectTicker, industry, subjectData, peerData, computedMetrics, customInstructions, dbTemplate, dbInstructions) {
  if (!dbTemplate)     throw new Error('[competitionPrompt] dbTemplate is required — configure skill "ofactor-competition" in DB');
  if (!dbInstructions) throw new Error('[competitionPrompt] dbInstructions is required — configure skill "ofactor-competition" in DB');

  const dataBlock    = buildDataBlock(subjectTicker, industry, subjectData, peerData, computedMetrics);
  const instructions = customInstructions ?? dbInstructions;

  return dbTemplate
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', instructions);
}

module.exports = { competitionPrompt, buildDataBlock, METRICS };
