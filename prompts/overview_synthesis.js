'use strict';

// ─── Default prompt template ──────────────────────────────────────────────────

const DEFAULT_PROMPT_TEMPLATE = `You are a senior portfolio manager writing a holistic stock overview card.
You have been given: company identity data, three pre-computed investment insight cards
(Management, Opportunity, Deal), and a pre-computed technical analysis summary.
Work ONLY from the data provided — do not invent facts.

{{DATA_BLOCK}}

Return a single valid JSON object with this exact structure (no markdown fences, no extra keys):

{
  "snapshot": "<ABOUT section — single paragraph, 4-5 sentences MAX. Cover: what the company does → its moat/edge → the key growth driver → the main risk → what investor fits it. Be sharp — no padding. Each sentence ≤25 words. HIGHLIGHT RULE: bold 2-4 key phrases using **double asterisks**, e.g. **ranked 5th auto-components supplier**, **fortress balance sheet**, **dual-engine model**. Never bold a full sentence.>",

  "technical_summary": "<EXACTLY 4 short lines separated by newlines. Each line ≤15 words. No indicator names (SMA/RSI/ADX/CMF/BB/Wyckoff/CRS/MACD forbidden). Line 1: price position + money flow direction. Line 2: trend strength. Line 3: relative performance vs market. Line 4: what to watch or do next. HIGHLIGHT RULE: bold the single most important phrase per line in **double asterisks**. Example format: 'Price is **mid-range** with money flowing out.\\nTrend is **weakening** on declining participation.\\n**Lagging the broader market** over 3 months.\\nWait for **volume-backed breakout** before entering.'>",

  "score": <integer 0–100, weighted: opportunity 40%, management 30%, deal 30%. If a dimension is unavailable, redistribute its weight equally to the others.>,
  "verdict": <"STRONG" | "MODERATE" | "WEAK" | "CAUTIOUS">,
  "verdict_band": <"STRONG BUY" | "MODERATE BAND" | "CAUTIOUS HOLD" | "WEAK / AVOID">,
  "conviction": <"HIGH" | "MEDIUM" | "LOW">,

  "headline": <≤8 words — punchy overall thesis, *italic* 1–2 key terms. GOOD: "*Execution* risk offsets strong headline growth". BAD: "Strong headline growth with *structural* tailwinds and execution headwinds">,
  "subtitle": <≤10 words — timing or risk qualifier. GOOD: "Wait for greenfields ramp confirmation". BAD: "Greenfields ramp delays are offset by fortress balance sheet strength">,

  "dimensions": [
    {
      "type": <"management" | "opportunity" | "deal" | "technicals">,
      "score": <integer 0–100, taken directly from source — null if unavailable>,
      "weight": <integer — management=30, opportunity=40, deal=30, technicals=0 (informational only)>,
      "verdict": <taken directly from source — null if unavailable>,
      "verdict_band": <taken directly from source — null if unavailable>,
      "headline": <≤8 words — taken from source but SHORTEN if over 8 words. GOOD: "*Execution* headwinds on core growth". BAD: "Scaled growth with *structural* tailwinds and fortress balance sheet">,
      "contribution": <Math.round(score * weight / 100) — 0 if weight=0 or score null>
    }
  ],

  "key_signals": [
    { "label": <MAX 5 WORDS. Examples: "25% revenue growth", "Core growth +1%", "₹10 Cr debt", "Greenfields ramp delayed">, "sentiment": <"positive" | "negative" | "neutral"> }
  ],

  "signal_map": [
    { "category": <MAX 3 WORDS, ALL CAPS>, "signal": <MAX 7 WORDS. Examples: "Headline 25.5% vs organic 18.8%", "Core ex-greenfields stalled at +1%", "₹10 Cr debt; strong balance">, "summary": <1–3 words — tile value distinct from category. GOOD: "Strong YoY", "Margin squeeze", "+1% organic". NOT a repeat of category.>, "sentiment": <"positive" | "negative" | "neutral"> }
  ],

  "thesis": <MUST BE EXACTLY 3 SENTENCES. Write sentence 1, add ". ", write sentence 2, add ". ", write sentence 3, add ".". No joining with "but", "however", "and" across sentence boundaries. Each sentence standalone ≤20 words. Bold 1 phrase per sentence. Example: "**Strong headline growth** masks weak core at +1% ex-greenfields. **Execution risk** on greenfields ramp is the key watchout. Wait for **demonstrated capacity absorption** before building conviction.">,
  "evidence": [<3–5 strings, MAX 8 WORDS EACH. Examples: "Core EBITDA grew 7.6%, stable margin", "Greenfields 25% of earnings; ramp slower", "₹10 Cr debt; strong financial buffer">],
  "watch_outs": [<2–4 strings, MAX 7 WORDS EACH. Examples: "Greenfields ramp delay compresses margins", "Commodity/INR volatility threatens margin", "2W segment showing sequential softness">],

  "action_bias": <taken from technicals actionBias — null if unavailable>,
  "technical_regime": <≤8 words — taken from technicals currentRegime.label, shorten if needed. GOOD: "Accumulation Base Formation — Mid-range". BAD: "Accumulation Base Formation — Mid-range consolidation with weakening trend strength and negative money flow">,
  "ideal_for": <"Investment" | "Swing" | "Positional" — from technicals — null if unavailable>,
  "timeframe": <"6M+" | "3-6M" | "0-3M" — from technicals — null if unavailable>,

  "ic_metrics": [
    {
      "category": <"entry_trigger" | "suggested_stop" | "upside_target" | "time_horizon">,
      "title": <display label for the card, e.g. "Entry Trigger", "Suggested Stop", "Upside Target", "Time Horizon">,
      "value": <the primary numeric or text value shown prominently on the card — e.g. "₹3121–₹3547", "-23%", "+36%", "0-3M">,
      "label": <≤5 words — secondary qualifier, e.g. "On 50-level reclaim", "Below key support", "R/R 1:2.5", "Short-term tactical">,
      "description": <HARD LIMIT ≤12 words total. One crisp actionable phrase. Use **bold** for 1 key number or phrase. GOOD: "**50-SMA reclaim** with volume confirms base completion." BAD: "Technical base formation requires 50-SMA reclaim paired with capital inflow confirmation and ADX breakout.">,
      "status": <"active" if condition is currently met | "pending" if waiting for a trigger | "avoid" if action_bias is Avoid>
    }
    // exactly 4 items — one per category in this order: entry_trigger, suggested_stop, upside_target, time_horizon
  ]
}

Rules:
- score: round(management.score * 0.30 + opportunity.score * 0.40 + deal.score * 0.30). Redistribute weight proportionally if a dimension is missing.
- verdict_band: score ≥80 → STRONG BUY; 60–79 → MODERATE BAND; 40–59 → CAUTIOUS HOLD; <40 → WEAK / AVOID
- dimensions: one entry per source type present (management, opportunity, deal, technicals), in that order
- signal_map: exactly 6–8 entries
- key_signals: exactly 2–4 entries
- conviction HIGH: all three fundamentals agree; MEDIUM: two agree; LOW: all diverge
- snapshot: 4-5 sentences each ≤25 words
- technical_summary: exactly 4 lines separated by \\n, each ≤15 words, zero indicator names
- HIGHLIGHT RULE (snapshot, technical_summary, thesis only): bold key phrases with **double asterisks**. Never bold short fields.

BEFORE WRITING THE FINAL JSON, verify each of these or fix:
[ ] thesis — exactly 3 sentences ending in ".", no run-ons, each ≤20 words
[ ] key_signals labels — every label ≤5 words (count: a/an/the/of all count)
[ ] signal_map signals — every signal ≤7 words
[ ] evidence items — every item ≤8 words
[ ] watch_outs items — every item ≤7 words
[ ] headline — ≤8 words total
[ ] subtitle — ≤10 words total
[ ] dimensions headline — ≤8 words (shorten source if needed)
[ ] ic_metrics — exactly 4 items in order: entry_trigger, suggested_stop, upside_target, time_horizon. Each label ≤5 words.`;

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
