'use strict';

// ─── Default prompt template ──────────────────────────────────────────────────

const DEFAULT_PROMPT_TEMPLATE = `You are a senior portfolio manager writing a holistic stock overview card.
You have been given: company identity data, three pre-computed investment insight cards (Management, Opportunity, Deal), and a pre-computed technical analysis summary.
Work ONLY from the data provided — do not invent facts.

{{DATA_BLOCK}}

Return a single valid JSON object matching the required schema. Field-level constraints (word limits, formatting, counts) are in the schema descriptions — follow them exactly.

Score formula: round(management.score × 0.30 + opportunity.score × 0.40 + deal.score × 0.30). Redistribute weight proportionally if a dimension is missing.
Conviction: HIGH if all three fundamentals agree; MEDIUM if two agree; LOW if all diverge.
Dimensions: include one entry per source type present (management, opportunity, deal, technicals), in that order.

HIGHLIGHT RULE: Apply markdown highlights ONLY to fields longer than 5 words. Use **double asterisks** to bold key phrases in snapshot, technical_summary, thesis, evidence, watch_outs, and dimensions[].headline. Use *single asterisks* to italicise 1–2 key terms in headline and subtitle. Never bold or italicise short fields (key_signals labels, signal_map signals/summary). Never bold a full sentence — highlight only the most diagnostic phrase per sentence/item.`;

// ─── Data block builder ───────────────────────────────────────────────────────

/**
 * Build the {{DATA_BLOCK}} string from company identity + insight objects.
 *
 * @param {object} identity   Output of peerIdentity.getIdentity()  (may be null)
 * @param {object} insights   { management, opportunity, deal, technicals } — each is the `insight` JSON from AiInsight (may be null/undefined per type)
 * @returns {string}
 */
function buildDataBlock(identity, insights) {
  const lines = [];

  // ── Company identity ──────────────────────────────────────────────────────
  lines.push('=== COMPANY IDENTITY ===');
  if (identity) {
    if (identity.companyName)   lines.push(`Company: ${identity.companyName}`);
    if (identity.ownershipGroup)lines.push(`Group / Promoter: ${identity.ownershipGroup}`);
    if (identity.industryGroup) lines.push(`Industry Group: ${identity.industryGroup}`);
    if (identity.basicIndustry) lines.push(`Basic Industry: ${identity.basicIndustry}`);
    if (identity.macroSector)   lines.push(`Macro Sector: ${identity.macroSector}`);
    if (identity.mainProduct)   lines.push(`Main Product / Business: ${identity.mainProduct}`);
    if (identity.description)   lines.push(`Description: ${identity.description}`);
  } else {
    lines.push('Identity data not available.');
  }
  lines.push('');

  // ── Fundamental insight cards ─────────────────────────────────────────────
  for (const dimType of ['management', 'opportunity', 'deal']) {
    const ins = insights[dimType];
    lines.push(`=== ${dimType.toUpperCase()} INSIGHT ===`);
    if (!ins) {
      lines.push('Not available.');
      lines.push('');
      continue;
    }
    lines.push(`Score: ${ins.score ?? 'N/A'}/100  Verdict: ${ins.verdict ?? 'N/A'}  Band: ${ins.verdict_band ?? 'N/A'}`);
    if (ins.headline)    lines.push(`Headline: ${ins.headline}`);
    if (ins.description) lines.push(`Description: ${ins.description}`);
    if (ins.thesis)      lines.push(`Thesis: ${ins.thesis}`);
    if (Array.isArray(ins.key_signals) && ins.key_signals.length > 0) {
      ins.key_signals.forEach(s => lines.push(`  [${(s.sentiment || '?').toUpperCase()}] ${s.label}`));
    }
    if (Array.isArray(ins.watch_outs) && ins.watch_outs.length > 0) {
      ins.watch_outs.slice(0, 2).forEach(w => lines.push(`  ! ${w}`));
    }
    lines.push('');
  }

  // ── Technicals ────────────────────────────────────────────────────────────
  lines.push('=== TECHNICALS INSIGHT ===');
  const tech = insights.technicals;
  if (!tech) {
    lines.push('Not available.');
  } else {
    if (tech.tag)                         lines.push(`Alignment Tag: ${tech.tag}`);
    if (tech.currentRegime?.label)        lines.push(`Regime: ${tech.currentRegime.label} — ${tech.currentRegime.description ?? ''}`);
    if (tech.actionBias)                  lines.push(`Action Bias: ${tech.actionBias}`);
    if (tech.convictionLevel)             lines.push(`Technical Conviction: ${tech.convictionLevel}`);
    if (tech.idealFor)                    lines.push(`Ideal For: ${tech.idealFor} (${tech.timeframe ?? 'N/A'})`);
    if (tech.actionableInsight?.action)   lines.push(`Action: ${tech.actionableInsight.action}`);
    if (tech.strategyViews?.growth)       lines.push(`Growth View: ${tech.strategyViews.growth}`);
    if (tech.strategyViews?.value)        lines.push(`Value View: ${tech.strategyViews.value}`);
    if (Array.isArray(tech.riskAlerts) && tech.riskAlerts.length > 0) {
      lines.push(`Technical Risks: ${tech.riskAlerts.join(', ')}`);
    }
    if (Array.isArray(tech.whatCanChange) && tech.whatCanChange.length > 0) {
      tech.whatCanChange.slice(0, 3).forEach(c => lines.push(`  ~ ${c}`));
    }
  }
  lines.push('');

  lines.push('Instructions:');
  lines.push('- Write the snapshot paragraph using ONLY the company identity and insight card data above.');
  lines.push('- Write the technical_summary using ONLY the Technicals section above — no indicator names.');
  lines.push('- Derive the composite score by weighting: opportunity 40%, management 30%, deal 30%.');
  lines.push('- Highlight convergence or divergence across dimensions in the thesis.');

  return lines.join('\n');
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full overview synthesis LLM prompt.
 *
 * @param {object|null} identity        From peerIdentity.getIdentity()
 * @param {object}      insights        { management, opportunity, deal, technicals }
 * @param {string|null} promptTemplate  DB-overridable template; falls back to DEFAULT
 * @returns {string}
 */
function overviewSynthesisPrompt(identity, insights, promptTemplate) {
  const template  = promptTemplate || DEFAULT_PROMPT_TEMPLATE;
  const dataBlock = buildDataBlock(identity, insights);
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { overviewSynthesisPrompt, buildDataBlock, DEFAULT_PROMPT_TEMPLATE };
