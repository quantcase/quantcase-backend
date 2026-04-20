'use strict';

// promptTemplate and outputSchema live entirely in the DB (Skill slug: "management-analysis").
// This file only contains the data-block builder and the prompt assembler
// that injects it into the DB-sourced template.

/**
 * @param {string}   ticker
 * @param {object[]} summaries     - summary_new rows for this ticker (oldest→newest)
 * @param {object[]} kpiValues     - kpi_values rows (source: transcript only)
 * @param {object[]} prowessValues - prowess_values_new rows for this company
 */
function buildDataBlock(ticker, summaries, kpiValues, prowessValues) {
  const lines = [];

  lines.push(`### Company: ${ticker}`);
  lines.push('');

  if (summaries.length > 0) {
    lines.push('### Earnings Call Intelligence (extracted from transcripts)');
    lines.push('');

    for (const s of summaries) {
      lines.push(`#### Period: ${s.callId}`);

      if (s.tone) {
        lines.push(`**Tone:** ${s.tone}  |  **Confidence:** ${s.confidence ?? 'N/A'}`);
      }

      if (s.entities) {
        lines.push('**Key Entities (management, auditor, board):**');
        lines.push(JSON.stringify(s.entities, null, 2));
      }

      if (s.milestones) {
        lines.push('**Milestones / Guidance Commitments:**');
        lines.push(JSON.stringify(s.milestones, null, 2));
      }

      if (s.governanceSignals) {
        lines.push('**Governance Signals:**');
        lines.push(JSON.stringify(s.governanceSignals, null, 2));
      }

      if (s.riskDisclosures) {
        lines.push('**Risk Disclosures:**');
        lines.push(JSON.stringify(s.riskDisclosures, null, 2));
      }

      if (s.industryAnalysis) {
        lines.push('**Industry Analysis:**');
        lines.push(JSON.stringify(s.industryAnalysis, null, 2));
      }

      lines.push('');
    }
  }

  if (kpiValues.length > 0) {
    lines.push('### KPI Values (source: transcript/PPT extraction)');
    lines.push('| Call ID | KPI | Value | Unit | Period Start | Period End |');
    lines.push('|---------|-----|-------|------|--------------|------------|');
    for (const k of kpiValues) {
      lines.push(`| ${k.callId} | ${k.kpi_abbr} | ${k.value ?? 'N/A'} | ${k.unit ?? ''} | ${k.start_date ?? ''} | ${k.end_date ?? ''} |`);
    }
    lines.push('');
  }

  if (prowessValues.length > 0) {
    lines.push('### Financial KPIs from Prowess (audited data)');
    lines.push('> ALWAYS prefer these values over transcript/PPT values for Revenue, Capex, and Operating Margin whenever both are available.');
    lines.push('');
    lines.push('| FY | Quarter | KPI | Value | Unit |');
    lines.push('|----|---------|-----|-------|------|');
    for (const p of prowessValues) {
      lines.push(`| ${p.fiscal_year ?? ''} | ${p.quarter ?? ''} | ${p.kpi_abbr} | ${p.value ?? 'N/A'} | ${p.unit ?? ''} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * @param {string}      ticker
 * @param {object[]}    summaries           - summary_new rows (all periods, oldest→newest)
 * @param {object[]}    kpiValues           - kpi_values rows (source: transcript only)
 * @param {object[]}    prowessValues       - prowess_values_new rows for this company
 * @param {string}      template            - DB promptTemplate (Skill slug: "management-analysis")
 * @param {string|null} defaultInstructions - DB defaultInstructions (injected at {{DEFAULT_INSTRUCTIONS}})
 */
function managementAnalysisPrompt(ticker, summaries, kpiValues, prowessValues, template, defaultInstructions = null) {
  if (!template) throw new Error('[managementAnalysisPrompt] template must come from DB — Skill slug: "management-analysis"');

  const dataBlock = buildDataBlock(ticker, summaries, kpiValues, prowessValues);

  return template
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', defaultInstructions ?? '');
}

module.exports = { managementAnalysisPrompt, buildDataBlock };
