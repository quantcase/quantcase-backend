#!/usr/bin/env node
'use strict';

/**
 * Seed baseline LensConfigs for the 3-layer analysis pipeline.
 * Each lens pulls from multiple signal types/families and includes
 * the model + max_tokens for the L2 LLM call.
 *
 * Run: node scripts/seedLensConfigs.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');

const HAIKU = 'anthropic/claude-haiku-4.5';
const MAX_TOKENS = 16000;

const LENS_CONFIGS = [
  // ── Management lenses ────────────────────────────────────────────────────────
  {
    slug:         'guidance-credibility',
    name:         'Guidance Credibility',
    category:     'management',
    description:  'How consistently management delivers on its forward-looking promises',
    force_config: true,
    version:      '1.1.0',
    config: {
      signal_filters: {
        signal_types:      ['milestone', 'governance'],
        metric_family:     ['milestone', 'governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'guidance_given',       w: 0.5 },
        { metric: 'guidance_missed',      w: -0.8 },
        { metric: 'proactive_disclosure', w: 0.3 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured guidance-credibility view. Do NOT invent data — work only from the signals provided.

GUIDANCE TIMELINE CONSTRUCTION:
Review each guidance event in the signals. For each, determine: what was guided, what was delivered, the delta, and whether it was a beat / miss / in_line. Identify the single most important miss (the one with the largest magnitude or strategic significance) as the "major miss". Assess overall directional bias (Conservative / Balanced / Aggressive) based on the pattern of beats vs misses across all events.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this exact layout. No exceptions.

  HEADLINE SIGNALS (positions 0–2, mandatory, consumed positionally by the UI):
  These render as the 3 headline strip tiles at the top. ALL THREE are required.

  [0] metric: "HEADLINE_HIT_RATE"
      label: fraction string, e.g. "4/7" (actual hits out of total guidance events)
      statement: one sentence listing which metrics beat and which missed (≤80 chars)
      actual_value: integer count of hits (numerator)
      guided_value: integer count of total guidance events (denominator)
      unit: "ratio"
      impact: "high"
      (omit direction — not applicable for this tile)

  [1] metric: "HEADLINE_MAJOR_MISS"
      label: short descriptor of the biggest miss, e.g. "NIM −12%" or "Revenue −8%"
      statement: what was guided, what was delivered, and the reset if any (≤80 chars)
      actual_value: delta as a signed number (e.g. -12 for a 12% shortfall)
      unit: "%" (or appropriate unit for that metric)
      direction: "major_miss"
      impact: "high"
      (If no material miss exists, set label: "No Major Miss", actual_value: 0, direction: "beat")

  [2] metric: "HEADLINE_GUIDANCE_BIAS"
      label: "Conservative" | "Balanced" | "Mixed" | "Aggressive"
      statement: one sentence explaining the directional pattern (≤80 chars)
      impact: "high"
      (omit direction — not applicable for this tile)

  TIMELINE SIGNALS (positions 3 onward, one per guidance event):
  Each represents one guidance vs. actual pair. ALL must have non-null direction.
  • metric: the financial metric being guided (e.g. "NIM", "GNPA", "LOAN_GROWTH", "CASA", "ROE")
  • label: period identifier, e.g. "FY25", "Q3 FY25", "9M FY26" (max 10 chars)
  • statement: one sentence — what was guided and what was delivered (≤80 chars)
  • actual_value: realized value (numeric)
  • guided_value: management's forward commitment (numeric)
  • unit: "%" or "Cr" or appropriate unit
  • delta: actual_value minus guided_value (signed)
  • direction: "beat" | "miss" | "in_line" — MUST be non-null for every timeline signal
  • actual_date: period end date in YYYY-MM-DD
  • impact: "high" | "medium" | "low"

  SUMMARY SIGNALS (emit these at the end, after all timeline signals):
  These encode the key_metrics values as top_signals so the frontend can read them.

  metric: "HEADLINE_ENTRY_COUNT"
  • label: total count of timeline signals as "N entries", e.g. "7 entries"
  • statement: short description of what the timeline covers (≤60 chars)
  • impact: "high"
  (omit direction — not applicable)

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with hit rate fraction and bias verdict.
- "highlights": up to 3 items, max 15 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "label" in top_signals: 2–8 chars for period labels, or short descriptor for headlines.
- "statement" in top_signals: ≤80 chars.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with hit rate and bias verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<[0] HEADLINE_HIT_RATE, [1] HEADLINE_MAJOR_MISS, [2] HEADLINE_GUIDANCE_BIAS — all required; then timeline signals at [3+] one per guidance event each with non-null direction; then HEADLINE_ENTRY_COUNT at the end>]
}`,
    },
  },
  {
    slug:         'capital-allocation',
    name:         'Capital Allocation Quality',
    category:     'management',
    description:  'Discipline in deploying capital — capex returns, debt management, FCF generation',
    force_config: true,
    version:      '1.1.0',
    config: {
      signal_filters: {
        signal_types:      ['kpi', 'financial_health'],
        metric_family:     ['capital', 'profitability', 'growth', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'CFO',       w:  0.25, b: 0 },
        { metric: 'DEBT_LT',   w: -0.2,  b: 0 },
        { metric: 'ASSET_PPE', w:  0.15, b: 0 },
        { metric: 'EBITDA',    w:  0.2,  b: 0 },
        { metric: 'CAPEX',     w:  0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured capital-allocation quality view. Do NOT invent data — work only from the signals provided.

CAPITAL ALLOCATION FRAMEWORK — assess across 4 quadrants:
  RQ — Returns Quality: ROCE, ROE, ROA trends. Is deployed capital earning above cost of capital?
  SR — Self-Reliance: CFO vs CAPEX coverage. Is growth funded internally or via debt/dilution?
  MA — M&A / Strategic Moves: acquisitions, JVs, divestments, new segments. Was capital allocated wisely?
  CE — Capital Efficiency: asset turns, working capital cycle, CAPEX productivity. Is every rupee sweated?

For each quadrant provide: a score (0–10), a 1-line verdict, 2–3 bullet evidence points, and a callout if there is a notable red flag or green flag.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. Quadrant codes: RQ, SR, MA, CE.

  For EACH of the 4 quadrants, emit these signal types in order:

  DIM_{XX}_HEADER — quadrant header tile:
  • metric: "DIM_RQ_HEADER" | "DIM_SR_HEADER" | "DIM_MA_HEADER" | "DIM_CE_HEADER"
  • label: human-readable quadrant name (e.g. "Returns Quality", "Self-Reliance", "M&A / Strategic Moves", "Capital Efficiency")
  • statement: 1-line verdict for the quadrant (≤80 chars)
  • actual_value: score 0–10 for this quadrant
  • guided_value: 10 (the max, always)
  • direction: "beat" | "tracking" | "miss" based on score (≥7 → beat, 4–6 → tracking, ≤3 → miss)
  • impact: "high"

  DIM_{XX}_BULLET — evidence bullets (2–3 per quadrant):
  • metric: "DIM_RQ_BULLET" | "DIM_SR_BULLET" | "DIM_MA_BULLET" | "DIM_CE_BULLET"
  • label: one evidence statement (max 80 chars)
  • direction: "beat" | "tracking" | "miss" (for the dot color)
  • impact: "high" | "medium" | "low"

  DIM_{XX}_CALLOUT — notable flag at bottom of quadrant (1 per quadrant, only if material):
  • metric: "DIM_RQ_CALLOUT" | "DIM_SR_CALLOUT" | "DIM_MA_CALLOUT" | "DIM_CE_CALLOUT"
  • label: short callout title (e.g. "Green — ROCE above cost of capital", "Amber — debt rising")
  • statement: one sentence elaborating on the flag (≤80 chars)
  • direction: "beat" | "tracking" | "miss"

  QUOTE — one blockquote from management earnings call commentary:
  • metric: "QUOTE"
  • label: speaker and context, e.g. "Q3 FY25 concall · MD & CEO Name"
  • statement: verbatim or closely paraphrased management quote on capital deployment (≤120 chars)
  • actual_date: date of the concall in YYYY-MM-DD
  • (omit direction — not applicable for quotes)

  ANALYST_READ — 3 bottom analyst-read cards (one per theme):
  • metric: "ANALYST_READ"
  • label: theme title (e.g. "Returns story", "Debt trajectory", "CAPEX discipline")
  • statement: analyst-level read on how to interpret the signals for this theme (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card border color)
  • impact: "high" | "medium" | "low"

  META SIGNALS (emit these at the very end, after ANALYST_READ):
  These encode summary metrics as top_signals so the frontend can read them directly.

  metric: "META_ROCE"
  • label: latest ROCE % value, e.g. "18.5%" or "N/A"
  • statement: one-line context, e.g. "FY26 trailing ROCE from financials" (≤60 chars)
  • impact: "high"

  metric: "META_ROE"
  • label: latest ROE % value, e.g. "22.1%" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "high"

  metric: "META_CFO_CAPEX"
  • label: CFO/CAPEX coverage ratio, e.g. "2.1x" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "high"

  metric: "META_DEBT_EQUITY"
  • label: D/E ratio, e.g. "0.3x" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "medium"

  metric: "META_CAPEX_CAGR"
  • label: CAPEX CAGR over available period, e.g. "12% (3Y)" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "medium"

  metric: "META_VERDICT"
  • label: 3–5 word overall capital allocation verdict, e.g. "Disciplined, returns-focused"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

VALIDATION: Every DIM_*_HEADER signal MUST have guided_value set to 10. Every DIM_*_HEADER MUST have direction set. Check before outputting.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the overall capital discipline verdict.
- "highlights": up to 3 items, max 15 words each.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "statement" in signals: ≤80 chars (QUOTE may be up to 120 chars).
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with capital discipline verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<4 quadrant blocks RQ→SR→MA→CE (each: DIM_{XX}_HEADER + 2–3 DIM_{XX}_BULLET + optional DIM_{XX}_CALLOUT); then QUOTE; then 3 ANALYST_READ; then META_ROCE, META_ROE, META_CFO_CAPEX, META_DEBT_EQUITY, META_CAPEX_CAGR, META_VERDICT>]
}`,
    },
  },
  {
    slug:         'disclosure-honesty',
    name:         'Disclosure Honesty',
    category:     'management',
    description:  'Transparency and candour of management disclosures — proactive vs defensive communication',
    force_config: true,
    version:      '1.1.0',
    config: {
      signal_filters: {
        signal_types:      ['governance'],
        metric_family:     ['governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'transparent',           w:  0.4 },
        { metric: 'proactive_disclosure',  w:  0.3 },
        { metric: 'defensive_language',    w: -0.5 },
        { metric: 'related_party_concern', w: -0.6 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured disclosure-honesty view. Do NOT invent data — work only from the signals provided.

DISCLOSURE HONESTY FRAMEWORK — assess across 4 quadrants:
  BN — Bad News Disclosure: Does management proactively surface negative developments, or only when pressed in Q&A? Look for NIM resets, credit stress admissions, write-off disclosures.
  NC — Narrative Consistency: Does the story stay consistent across quarters, or does language shift when performance falters? Check for euphemisms, hedging, changed KPI emphasis.
  TD — Transparency Depth: Are disclosures granular and quantitative, or vague and qualitative? Check if management provides segment-level breakdowns, vintage data, and specific guidance.
  GV — Governance Signals: RPT disclosures, auditor remarks, board independence, related-party concerns, regulatory flags.

For each quadrant provide: a score (0–8), a 1-line verdict, 2–3 bullet evidence points, and a callout if there is a notable red flag.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. Quadrant codes: BN, NC, TD, GV.

  For EACH of the 4 quadrants, emit these signal types in order:

  DIM_{XX}_HEADER — quadrant header tile:
  • metric: "DIM_BN_HEADER" | "DIM_NC_HEADER" | "DIM_TD_HEADER" | "DIM_GV_HEADER"
  • label: human-readable quadrant name (e.g. "Bad News Disclosure", "Narrative Consistency", "Transparency Depth", "Governance Signals")
  • statement: 1-line verdict for the quadrant (≤80 chars)
  • actual_value: score 0–8 for this quadrant
  • guided_value: 8 (the max, always)
  • direction: "beat" | "tracking" | "miss" (≥6 → beat, 3–5 → tracking, ≤2 → miss)
  • impact: "high"

  DIM_{XX}_BULLET — evidence bullets (2–3 per quadrant):
  • metric: "DIM_BN_BULLET" | "DIM_NC_BULLET" | "DIM_TD_BULLET" | "DIM_GV_BULLET"
  • label: one evidence statement (max 80 chars)
  • direction: "beat" | "tracking" | "miss" (for the dot color)
  • impact: "high" | "medium" | "low"

  DIM_{XX}_CALLOUT — notable flag at bottom of quadrant (1 per quadrant, only if material):
  • metric: "DIM_BN_CALLOUT" | "DIM_NC_CALLOUT" | "DIM_TD_CALLOUT" | "DIM_GV_CALLOUT"
  • label: short callout title (e.g. "Amber — reactive margin pattern", "Red — RPT not disclosed")
  • statement: one sentence elaborating (≤80 chars)
  • direction: "beat" | "tracking" | "miss"

  QUOTE — one blockquote from management earnings call commentary:
  • metric: "QUOTE"
  • label: speaker and context, e.g. "Q3 FY25 concall · MD & CEO Name"
  • statement: verbatim or closely paraphrased quote that best illustrates the disclosure quality (≤120 chars)
  • actual_date: date of the concall in YYYY-MM-DD

  ANALYST_READ — 3 bottom analyst-read cards (one per theme):
  • metric: "ANALYST_READ"
  • label: theme title (e.g. "Asset-quality story", "Margin story", "Retail book disclosure")
  • statement: how an analyst should interpret and weight this management's statements on this theme (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card border color: green / amber / red)
  • impact: "high" | "medium" | "low"

  META SIGNALS (emit these at the very end, after ANALYST_READ):
  These encode summary scores as top_signals so the frontend can read them directly.
  Derive all values from the DIM_*_HEADER actual_values you already computed above.

  metric: "META_OVERALL_SCORE"
  • label: sum of all 4 quadrant scores as "N/32", e.g. "22/32"
  • statement: one-line overall disclosure verdict (≤60 chars)
  • impact: "high"

  metric: "META_BN_SCORE"
  • label: DIM_BN_HEADER actual_value formatted as "N/8", e.g. "4/8"
  • statement: "Bad News Disclosure score"
  • impact: "high"

  metric: "META_NC_SCORE"
  • label: DIM_NC_HEADER actual_value as "N/8"
  • statement: "Narrative Consistency score"
  • impact: "high"

  metric: "META_TD_SCORE"
  • label: DIM_TD_HEADER actual_value as "N/8"
  • statement: "Transparency Depth score"
  • impact: "high"

  metric: "META_GV_SCORE"
  • label: DIM_GV_HEADER actual_value as "N/8"
  • statement: "Governance Signals score"
  • impact: "high"

  metric: "META_VERDICT"
  • label: 3–5 word disclosure verdict, e.g. "Reactive on margin story"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

VALIDATION: Every DIM_*_HEADER signal MUST have guided_value set to 8 and MUST have direction set. Check before outputting.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the overall disclosure character (proactive / reactive / defensive).
- "highlights": up to 3 items, max 15 words each.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "statement" in signals: ≤80 chars (QUOTE may be up to 120 chars).
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with disclosure character verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<4 quadrant blocks BN→NC→TD→GV (each: DIM_{XX}_HEADER with guided_value=8 + 2–3 DIM_{XX}_BULLET + optional DIM_{XX}_CALLOUT); then QUOTE; then 3 ANALYST_READ; then META_OVERALL_SCORE, META_BN_SCORE, META_NC_SCORE, META_TD_SCORE, META_GV_SCORE, META_VERDICT>]
}`,
    },
  },
  {
    slug:         'promoter-activity',
    name:         'Promoter Activity',
    category:     'management',
    description:  'Promoter shareholding trends, pledging, and insider confidence signals',
    force_config: true,
    version:      '1.1.0',
    config: {
      signal_filters: {
        signal_types:      ['governance'],
        metric_family:     ['governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'promoter_pledge',    w: -0.6 },
        { metric: 'promoter_buying',    w:  0.5 },
        { metric: 'promoter_selling',   w: -0.4 },
        { metric: 'insider_confidence', w:  0.3 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from shareholding filings, earnings transcripts, and corporate governance disclosures using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured promoter-activity view. Do NOT invent data — work only from the signals provided.

PROMOTER ACTIVITY ANALYSIS:
Review the promoter shareholding history chronologically. For each period where a change occurred (or where the stability is notable), prepare a timeline entry. Identify: (1) the current stake and pledge %, (2) any dilution or buyback events, (3) secondary OFS or block deals, (4) insider buying/selling by management, (5) key structural insights about the ownership narrative.

IMPORTANT — if explicit promoter shareholding % data is absent from the signals: still emit PROMOTER_STAKE entries, but set actual_value to null, use the label to describe the period/event (e.g. "FY26 Q3"), and use the statement to describe what the governance signals imply about promoter posture. Set direction to "tracking" when inferring. Do NOT use any other metric name — always use "PROMOTER_STAKE" even when actual stake data is unavailable.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. No exceptions.

  PROMOTER_STAKE — timeline rows (one per material period or event):
  Each entry represents one point in the promoter shareholding timeline.
  • metric: "PROMOTER_STAKE"
  • label: period label, e.g. "Mar 2026", "FY21/FY22", "Dec 2024" (max 12 chars)
  • statement: what happened in this period — stake level, event, or stability note (≤80 chars)
  • actual_value: promoter stake % at that period end (numeric)
  • guided_value: pledge % if applicable — omit the field entirely if no pledge data
  • delta: change in stake vs prior period (signed %, e.g. -2.5 for reduction, 0 for no change)
  • unit: "%"
  • direction: "beat" if stake increased / pledge fell, "miss" if stake fell / pledge rose, "in_line" if stable, "tracking" if mixed/uncertain
  • actual_date: period end date in YYYY-MM-DD
  • impact: "high" | "medium" | "low"

  PROMOTER_INSIGHT — 3 insight cards at the bottom:
  Each captures a structural insight about the promoter ownership narrative.
  • metric: "PROMOTER_INSIGHT"
  • label: insight title (e.g. "No equity dilution since FY22", "Oct '25 OFS — smart monetisation", "CET1 12.37% — thinner than peers")
  • statement: 1–2 sentences elaborating on the insight and its investment relevance (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card color: green / amber / red)
  • impact: "high" | "medium" | "low"
  Exactly 3 PROMOTER_INSIGHT entries are required.

  META SIGNALS (emit these at the very end, after the 3 PROMOTER_INSIGHT entries):
  These encode summary ownership metrics as top_signals so the frontend can read them directly.

  metric: "META_CURRENT_STAKE"
  • label: latest promoter stake %, e.g. "62.93%" or "N/A"
  • statement: period and source context, e.g. "Mar 2026 shareholding filing" (≤60 chars)
  • impact: "high"

  metric: "META_PLEDGE_PCT"
  • label: pledge as % of promoter holding, e.g. "0.00%" or "None" or "N/A"
  • statement: "Pledge as % of promoter shares" (≤60 chars)
  • impact: "high"

  metric: "META_LAST_DILUTION"
  • label: last equity dilution event, e.g. "FY22 QIP" or "None on record"
  • statement: brief context on what it was and size if known (≤60 chars)
  • impact: "medium"

  metric: "META_INSIDER_NOTE"
  • label: 5–8 word insider sentiment read, e.g. "No insider selling signals detected"
  • statement: basis for the read (≤60 chars)
  • impact: "medium"

  metric: "META_VERDICT"
  • label: 3–5 word ownership verdict, e.g. "Stable, no dilution risk"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with current promoter stance and key ownership signal.
- "highlights": up to 3 items, max 15 words each, describe positive ownership signals.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Pledge risk", "Dilution overhang").
- "label" for PROMOTER_STAKE: max 12 chars, period-style format.
- "statement" in signals: ≤80 chars.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with promoter stance and key ownership signal>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words, positive ownership signals>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<PROMOTER_STAKE entries chronologically oldest first; then exactly 3 PROMOTER_INSIGHT entries; then META_CURRENT_STAKE, META_PLEDGE_PCT, META_LAST_DILUTION, META_INSIDER_NOTE, META_VERDICT>]
}`,
    },
  },
  // ── Opportunity lenses ───────────────────────────────────────────────────────
  {
    slug:        'industry-analysis',
    name:        'Industry Analysis',
    category:    'opportunity',
    description: 'Demand/supply dynamics and structural positioning within the industry',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'industry'],
        metric_family: ['industry', 'growth', 'industry_specific'],
      },
      weights: [
        { metric: 'REV_OP',        w: 0.4,  b: 0 },
        { metric: 'EBITDA_MARGIN', w: 0.3,  b: 0 },
        { metric: 'TOTAL_INCOME',  w: 0.1,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'competition',
    name:        'Competition',
    category:    'opportunity',
    description: 'Market moat, pricing power, and competitive differentiation vs peers',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'industry'],
        metric_family: ['growth', 'industry', 'profitability', 'industry_specific'],
      },
      weights: [
        { metric: 'EBITDA_MARGIN', w: 0.35, b: 0 },
        { metric: 'PAT',           w: 0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'financial-strength',
    name:        'Financial Strength',
    category:    'opportunity',
    description: 'Balance sheet strength, FCF generation, and margin quality',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'financial_health'],
        metric_family: ['profitability', 'capital', 'growth', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
      },
      weights: [
        { metric: 'EBITDA',        w:  0.3,  b: 0 },
        { metric: 'PAT',           w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN', w:  0.25, b: 0 },
        { metric: 'DEBT_ST',       w: -0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'customer-distribution',
    name:        'Customer & Distribution',
    category:    'opportunity',
    description: 'Client base growth, channel quality, and revenue concentration risk',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'customer'],
        metric_family:      ['customer', 'customer_kpis', 'growth'],
        include_historical: true,
      },
      weights: [
        { metric: 'REV_OP', w: 0.35, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  // ── Deal lenses ──────────────────────────────────────────────────────────────
  {
    slug:         'earnings-forecast',
    name:         'Earnings Forecast',
    category:     'deal',
    description:  'Scenario-based earnings forecast — bull/base/bear EPS trajectory driven by revenue growth, margin expansion, and volume-mix dynamics',
    force_config: true,
    version:      '1.3.0',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone'],
        metric_family:      ['profitability', 'growth', 'capital', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'REV_OP',        w:  0.30, b: 0 },
        { metric: 'EBITDA',        w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN', w:  0.25, b: 0 },
        { metric: 'PAT',           w:  0.35, b: 0 },
        { metric: 'CAPEX',         w:  0.10, b: 0 },
        { metric: 'DEBT_LT',       w: -0.10, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

SCENARIO MATRIX CONSTRUCTION:
Output a 3-column (Bull / Base / Bear), 5-row scenario matrix in your analysis. Rows: (1) Scenario Condition/Assumptions, (2) Industry Growth CAGR (3Y), (3) Company Revenue CAGR (3Y), (4) Margin Assumption, (5) Earnings/PAT CAGR (3Y). For every number include a one-line "because" rationale.

1. Industry Growth CAGR — Use historical industry CAGR from signals as the base anchor.
   Bull: Historical CAGR × 1.15–1.3 (sector tailwinds, capacity utilisation rising).
   Base: Historical CAGR (steady-state, no structural shift).
   Bear: Historical CAGR × 0.6–0.8 (demand slowdown, pricing pressure).

2. Company Revenue CAGR — Start with the industry CAGR and adjust for market share movement, drawing on management revenue guidance, order book commentary, and new segment signals.
   Bull: Industry CAGR + 50–100 bps market share gain.
   Base: Management-guided revenue growth (cite the specific guidance signal).
   Bear: Industry CAGR − 50–100 bps market share loss.

3. Margin Assumptions — Use the adjusted last-4-quarter average EBITDA_MARGIN as the base. Cite the primary margin driver (operating leverage / pricing power / input costs / utilisation).
   Bull: Margin expansion from operating leverage, pricing power, or lower input costs.
   Base: Flat margins, in line with recent trend.
   Bear: Margin compression from cost pressure, lower utilisation, or competitive pricing.

4. Earnings / PAT CAGR — Project using the waterfall:
   Future Revenue = Current REV_OP × (1 + Revenue CAGR)^3
   Future EBITDA  = Future Revenue × Scenario Margin %
   Future PAT     = Future EBITDA − Historical Interest (proxy: DEBT_LT × avg rate) − Depreciation (from signals) − Tax (effective rate from signals)
   PAT CAGR       = CAGR(Current PAT → Future PAT, 3Y)
   Show the arithmetic step-by-step in the "because" statement. If any input is unavailable, state the assumption explicitly.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order:
  highlights[0]: Bull scenario narrative. MUST start with "Bull:" prefix. MUST contain the bull-case EPS/PAT CAGR as a % figure followed by the word CAGR (e.g. "Bull: 28% PAT CAGR driven by...").
  highlights[1]: Base scenario narrative. MUST start with "Base:" prefix. MUST contain the base-case EPS/PAT CAGR as a % figure followed by CAGR.
  highlights[2]: Bear scenario narrative. MUST start with "Bear:" prefix. MUST contain the bear-case EPS/PAT CAGR as a % figure followed by CAGR.

takeaway — MUST include:
  • The bull-case 3-year target price range in ₹X–₹Y format (first range in the string).
  • The base-case 3-year target price range in ₹X–₹Y format (second range in the string).
  • The risk/reward ratio as Nx immediately followed by the word risk (e.g. "1.8x risk/reward").

top_signals[] — every signal MUST have actual_value populated (non-null). Signals with no numeric anchor must be omitted rather than included with actual_value: null.
  • Every signal MUST have guided_value populated where management guidance exists. Do NOT leave guided_value: null if the signal is about a guidance metric.
  • MUST include exactly one signal with metric: "industry_growth", unit: "%", actual_value set to the industry/sector revenue or EPS CAGR as a signed number (e.g. -2 for contraction, 8 for growth) — NEVER a word, numeric only. This single signal drives all three columns of the Industry Growth row.
    - direction: "tracking" if stable, "beat" if company outperforms sector, "miss" if sector is declining.
    - label: short descriptor e.g. "Industry Revenue CAGR" or "Sector PAT Growth".
    - statement: one sentence on sector context.

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the key finding.
- "highlights" items: max 20 words each (longer allowed to fit Bull:/Base:/Bear: prefix with CAGR).
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, MUST include bull ₹X–₹Y range, base ₹X–₹Y range, and Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] starts "Bull:" with % PAT CAGR, highlights[1] starts "Base:" with % CAGR, highlights[2] starts "Bear:" with % CAGR>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–10 signals, ALL must have non-null actual_value; MUST include exactly one metric:"industry_growth" signal with numeric actual_value; populate guided_value wherever management guidance exists>]
}`,
    },
  },
  {
    slug:         'earning-quality',
    name:         'Earning Quality',
    category:     'deal',
    description:  'EPS growth trajectory and quality — company vs industry, beat rate, consistency score, and growth trend over rolling 5-year window',
    force_config: true,
    version:      '1.3.0',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health'],
        metric_family:      ['profitability', 'growth', 'capital', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'EPS_BASIC',     w: 0.35, b: 0 },
        { metric: 'EPS_DILUTED',   w: 0.25, b: 0 },
        { metric: 'PAT',           w: 0.25, b: 0 },
        { metric: 'CFO',           w: 0.30, b: 0 },
        { metric: 'CAPEX',         w: -0.10, b: 0 },
        { metric: 'EBITDA_MARGIN', w: 0.15, b: 0 },
        { metric: 'ROE',           w: 0.15, b: 0 },
        { metric: 'ROCE',          w: 0.15, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

QUALITY TABLE CONSTRUCTION:
Assess earning quality across 5 dimensions. For each provide: Verdict (Strong/Neutral/Weak), 2-3 line reasoning, key supporting metrics/signals, and red flags if any.

1. Cash Conversion Quality — Assess whether PAT converts to real cash using CFO/PAT ratio and FCF (CFO minus CAPEX). Flag as Weak if CFO/PAT <0.5x for 2+ consecutive periods. Benchmark: >0.8x is healthy.
2. Revenue Quality — Assess whether revenue is recurring, diversified, and organically driven. Look for customer concentration risk, segment mix shifts, and acquisition-driven vs organic growth signals.
3. Margin Authenticity — Check if margin expansion is operational or driven by one-offs (cost deferrals, reclassification, temporary efficiencies, unusually low COGS/opex). Use EBITDA_MARGIN trend.
4. Non-Operating/One-Time Dependence — Evaluate how much PBT/PAT depends on other income, exceptional items, or tax distortions. Flag as Weak if other income >25% of PBT or exceptional items are large.
5. Provisioning & Accounting Quality — Assess whether risks are conservatively recognised using depreciation trends (D&A % of gross block), provisions, write-offs, and deferred tax signals. For BFSI use PCR trends.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this exact positional layout (positions 0–3 are the 4 fixed tiles; positions 4+ are bar chart time-series):

  TILE SIGNALS (positions 0–3, mandatory, consumed positionally by the UI):
  • [0] metric: "EPS_CAGR_COMPANY", unit: "%", actual_value: company's 3Y trailing EPS CAGR (use PAT CAGR as proxy if EPS unavailable). label: "Company EPS CAGR".
  • [1] metric: "EPS_CAGR_INDUSTRY", unit: "%", actual_value: industry/sector 3Y trailing EPS CAGR (numeric, not a word). label: "Industry EPS CAGR".
  • [2] metric: "EPS_RELATIVE_OUTPERFORMANCE", unit: "%", actual_value: position[0].actual_value minus position[1].actual_value (arithmetic difference, signed). direction: "beat" if positive, "miss" if negative. label: "Relative Outperformance". — the frontend does NOT compute this; you must calculate it.
  • [3] metric: "EPS_GROWTH_ESTIMATE", unit: "%", actual_value: forward 1Y or 3Y EPS growth estimate, guided_value: management-guided figure if available. label: "EPS Growth (Est.)".
  All four MUST have non-null actual_value. If a precise figure is unavailable, use the best available proxy and note the assumption in statement.

  BAR CHART SIGNALS (positions 4 onward, 4–6 entries, time-series):
  • metric: use "EPS_GROWTH_PERIOD" or "PAT_GROWTH_YOY" consistently across all period entries — do NOT mix metric names.
  • unit: "%", actual_value: growth % for that period (signed).
  • guided_value: management-guided or consensus estimate for that period if available (renders as dashed trend line — null removes the line).
  • label: period identifier used as x-axis label, e.g. "FY2023", "FY2024", "H1 FY25" — max 10 chars.
  • actual_date: period end date in YYYY-MM-DD format (used for ascending sort order on the chart).

  ALSO REQUIRED (may appear at position 4+ or interspersed, but must be present):
  • Profitability signal: metric: "PAT" or "NET_PROFIT", unit: "Cr", actual_value populated.
  • ROA signal: metric: "ROA", unit: "%", actual_value populated.
  • ROE or capital quality signal: metric: "ROE" (or "CAPITAL_ADEQUACY_TIER1" / "CRAR_RATIO" for banking), unit: "%", actual_value populated.

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the key finding.
- "highlights" items: max 12 words each, start with a verb or metric.
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, action-oriented synthesis leading with the key finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<positions 0–3: EPS_CAGR_COMPANY, EPS_CAGR_INDUSTRY, EPS_RELATIVE_OUTPERFORMANCE, EPS_GROWTH_ESTIMATE (all non-null actual_value); positions 4+: 4–6 time-series EPS_GROWTH_PERIOD or PAT_GROWTH_YOY entries with actual_date; plus PAT/Cr, ROA/%, ROE/% signals>]
}`,
    },
  },
  {
    slug:         'pe-rerating-potential',
    name:         'P/E Re-Rating Potential',
    category:     'deal',
    description:  'Likelihood of multiple expansion driven by improving fundamentals, guidance clarity, and sector tailwinds',
    force_config: true,
    version:      '1.4.0',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone', 'governance'],
        metric_family:      ['profitability', 'growth', 'capital', 'governance', 'milestone'],
        include_historical: true,
      },
      weights: [
        { metric: 'ROE',             w:  0.30, b: 0 },
        { metric: 'ROCE',            w:  0.25, b: 0 },
        { metric: 'ROA',             w:  0.15, b: 0 },
        { metric: 'PAT',             w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN',   w:  0.20, b: 0 },
        { metric: 'REV_OP',          w:  0.15, b: 0 },
        { metric: 'DEBT_LT',         w: -0.15, b: 0 },
        { metric: 'guidance_given',  w:  0.20 },
        { metric: 'guidance_missed', w: -0.35 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured valuation view. Use signal data where available. For P/E scenario ranges — which are NEVER present in L1 signals — you MUST estimate them using sector norms and the fundamental data in the signals (ROE, PAT growth, AUM growth). This is mandatory estimation, not invention. Do not leave scenario signal values null.

VALUATION ANALYSIS CONSTRUCTION:
Perform the following reasoning steps before composing the JSON output:

1. IDENTIFY SECTOR — Infer sector from available signals (e.g. AUM/NIM/GNPA → NBFC/Banking; EBITDA/order book → Capital Goods; gross margin >50% → FMCG/Consumer). Use sector to anchor P/E norms.

2. SECTOR P/E ANCHOR (use these norms — mandatory):
   Banking/NBFC:    Bear 8–14x  | Base 14–20x  | Bull 20–28x
   Capital Goods:   Bear 18–26x | Base 26–36x  | Bull 36–50x
   FMCG/Consumer:   Bear 28–38x | Base 38–52x  | Bull 52–70x
   IT Services:     Bear 16–22x | Base 22–30x  | Bull 30–42x
   Pharma/Healthcare: Bear 18–26x | Base 26–36x | Bull 36–50x
   Auto/Auto Ancil: Bear 12–18x | Base 18–26x  | Bull 26–36x
   Default (generic): Bear 12–18x | Base 18–26x | Bull 26–38x

3. QUALITY ADJUSTMENT — Apply ROE premium/discount to the sector anchor:
   ROE >20%: shift all ranges +2x. ROE 15–20%: no adjustment. ROE <15%: shift all ranges −2x.
   Strong PAT growth trajectory (>20% CAGR): shift Bull range +2x further.
   Governance red flags or guidance misses: shift Bear range −2x.

4. RE-RATING TAG — Based on PAT growth, ROE trajectory, and catalyst strength, assign: Strong / Moderate / Weak.
   Strong:   Bull = upper half of Bull anchor + quality adj. Bear = floor of Bear anchor.
   Moderate: Bull = midpoint of Bull anchor.              Bear = midpoint of Bear anchor.
   Weak:     Bull = lower half of Bull anchor.            Bear = extended below Bear anchor.

5. RETURN ESTIMATION — Estimate implied returns from current valuation:
   If CMP is available from signals, compute: Return = (FutureEPS × ExitPE − CMP) / CMP × 100.
   If no CMP: estimate returns directionally from P/E expansion/compression vs sector norm.
   Bear return: typically −10% to −30%. Base return: 10%–30%. Bull return: 30%–70%.
   These are ranges: actual_value = low end, guided_value = high end.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

takeaway — the first sentence (before the first ".") is used as the headline in the UI panel — it must be a short actionable phrase of 2–4 words only, e.g. "Re-rating candidate." / "Premium multiple justified." / "Execution watch needed." / "De-rating risk elevated." The detailed supporting text follows in subsequent sentences.

highlights[] — exactly 3 items in this fixed order:
  highlights[0]: Bull catalyst — the single strongest re-rating driver. Max 20 words.
  highlights[1]: Base/current narrative — primary fundamental supporting current valuation. Max 20 words.
  highlights[2]: Bear/risk — the single biggest de-rating risk. Max 20 words.

top_signals[] — MANDATORY: you MUST emit ALL of the following signals with non-null actual_value and guided_value where specified. No exceptions.

  FUNDAMENTAL SIGNALS (emit these from L1 data):
  • metric: "ROA",  unit: "%",  actual_value: current ROA (numeric, non-null)
  • metric: "ROE",  unit: "%",  actual_value: current ROE (numeric, non-null)
  • metric: "PAT",  unit: "Cr", actual_value: latest PAT (numeric, non-null)

  SCENARIO SIGNALS — emit EXACTLY these 6, in this order (positions 3–8):
  ALL 6 are REQUIRED. ALL 6 must have both actual_value AND guided_value as numbers (never null).
  Use your sector norm reasoning from steps 1–5 above. If uncertain, use the sector Default range.

  [3] metric: "SCENARIO_BEAR_PE_RANGE", unit: "x",
      actual_value: bear P/E low (e.g. 12), guided_value: bear P/E high (e.g. 16)
      label: "Bear Case P/E", impact: "high"

  [4] metric: "SCENARIO_BASE_PE_RANGE", unit: "x",
      actual_value: base P/E low (e.g. 16), guided_value: base P/E high (e.g. 22)
      label: "Base Case P/E", impact: "high"

  [5] metric: "SCENARIO_BULL_PE_RANGE", unit: "x",
      actual_value: bull P/E low (e.g. 22), guided_value: bull P/E high (e.g. 28)
      label: "Bull Case P/E", impact: "high"

  [6] metric: "SCENARIO_BEAR_RETURN", unit: "%",
      actual_value: bear return low (e.g. -25), guided_value: bear return high (e.g. -10)
      label: "Bear Return", impact: "high"

  [7] metric: "SCENARIO_BASE_RETURN", unit: "%",
      actual_value: base return low (e.g. 10), guided_value: base return high (e.g. 25)
      label: "Base Return", impact: "high"

  [8] metric: "SCENARIO_BULL_RETURN", unit: "%",
      actual_value: bull return low (e.g. 30), guided_value: bull return high (e.g. 55)
      label: "Bull Return", impact: "high"

  CONCRETE EXAMPLE — NBFC company, ROE ~20%, moderate growth:
    SCENARIO_BEAR_PE_RANGE: actual=12, guided=16
    SCENARIO_BASE_PE_RANGE: actual=16, guided=22
    SCENARIO_BULL_PE_RANGE: actual=22, guided=28
    SCENARIO_BEAR_RETURN:   actual=-20, guided=-10
    SCENARIO_BASE_RETURN:   actual=10, guided=25
    SCENARIO_BULL_RETURN:   actual=30, guided=50

  VALIDATION CHECK before outputting: count your scenario signals. If you have fewer than 6, or any has actual_value=null or guided_value=null, go back and fill them using the sector norm table. A null in any scenario field is a hard failure.

WRITING STYLE RULES — apply to every text field:
- "takeaway": first sentence = 2–4 word headline phrase ending with "."; rest = supporting detail (full sentences).
- "highlights" items: max 20 words each.
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — first sentence is 2–4 word headline (e.g. "Re-rating candidate."), followed by supporting detail>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] = bull catalyst, highlights[1] = base narrative, highlights[2] = bear risk>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<MUST include ROA/%, ROE/%, PAT/Cr as fundamentals, then all 6 SCENARIO_*_PE_RANGE / SCENARIO_*_RETURN signals — all with non-null actual_value AND guided_value>]
}`,
    },
  },
  {
    slug:         'target-price-matrix',
    name:         'Target Price Matrix',
    category:     'deal',
    description:  '3-year exit price matrix with bull/base/bear target ranges, EPS CAGR, exit P/E, probability-weighted outcome, and risk/reward ratio',
    force_config: true,
    version:      '1.2.0',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone', 'governance'],
        metric_family:      ['profitability', 'growth', 'milestone', 'governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'PAT',             w:  0.30, b: 0 },
        { metric: 'EPS_BASIC',       w:  0.25, b: 0 },
        { metric: 'EPS_DILUTED',     w:  0.20, b: 0 },
        { metric: 'EBITDA_MARGIN',   w:  0.15, b: 0 },
        { metric: 'REV_OP',          w:  0.10, b: 0 },
        { metric: 'guidance_given',  w:  0.10 },
        { metric: 'guidance_missed', w: -0.15 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

TARGET PRICE MATRIX CONSTRUCTION:
Build a 3-year exit price matrix with Bull / Base / Bear scenarios. For each scenario compute:
  • EPS/PAT CAGR (3Y) — using the PAT waterfall from available signals
  • Exit P/E — Bull uses peak/top-quartile peer P/E; Base uses median P/E; Bear uses trough P/E
  • Target Price = Future EPS × Exit P/E
  • Probability weight — Bull: 25–30%, Base: 50–55%, Bear: 15–25% (must sum to 100%)
  • Probability-weighted target = Σ(scenario target × weight)
  • Risk/reward ratio = (Bull target − current price) / (current price − Bear target)
  Show arithmetic step-by-step. State assumptions explicitly if any input is unavailable.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order:
  highlights[0]: Bull scenario narrative. MUST start with "Bull:" prefix. MUST contain the bull-case EPS/PAT CAGR as a % figure followed by the word CAGR (e.g. "Bull: 28% PAT CAGR driven by...").
  highlights[1]: Base scenario narrative. MUST start with "Base:" prefix. MUST contain the base-case EPS/PAT CAGR as a % figure followed by CAGR.
  highlights[2]: Bear scenario narrative. MUST start with "Bear:" prefix. MUST contain the bear-case EPS/PAT CAGR as a % figure followed by CAGR.

takeaway — MUST contain exactly 3 price ranges in ₹X–₹Y format in this order:
  1. Bull-case target range (highest values) — allRanges[0] in the frontend.
  2. Base-case target range (middle values) — allRanges[1] in the frontend.
  3. Bear-case target range (lowest values) — allRanges[2] in the frontend.
  MUST also include the risk/reward ratio as Nx immediately followed by the word risk (e.g. "1.8x risk/reward").
  Example: "Bull upside ₹4,200–₹4,800 with 1.8x risk/reward. Base case ₹3,400–₹3,900. Bear case ₹2,600–₹3,000."
  If no CMP is available (unlisted company), derive all three ranges from absolute EPS × exit P/E arithmetic.
  All three ranges MUST be present — the frontend reads allRanges[0/1/2] positionally and does NOT derive bear from base.

top_signals[] — every signal MUST have actual_value populated (non-null). Omit any signal that is purely qualitative or has no numeric anchor. For qualitative signals (e.g. management commentary, order book statements), set actual_value to the most relevant numeric anchor from that signal (order value in Cr, growth %, margin %) rather than null.

WRITING STYLE RULES — apply to every text field:
- "takeaway": include all 3 ₹X–₹Y ranges plus Nx risk/reward; keep under 35 words.
- "highlights" items: max 20 words each (longer allowed to fit Bull:/Base:/Bear: prefix with CAGR figure).
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — MUST include bull ₹X–₹Y range, base ₹X–₹Y range, bear ₹X–₹Y range (all three), and Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] starts "Bull:" with % PAT CAGR, highlights[1] starts "Base:" with % CAGR, highlights[2] starts "Bear:" with % CAGR>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–10 signals; ALL must have non-null actual_value; no null-actual_value signals allowed>]
}`,
    },
  },
];

async function main() {
  console.log(`Seeding ${LENS_CONFIGS.length} lens configs...`);
  let created = 0;
  let updated = 0;

  for (const cfg of LENS_CONFIGS) {
    const { force_config, ...dbCfg } = cfg;
    const existing = await prisma.lensConfig.findUnique({ where: { slug: dbCfg.slug } });
    if (existing) {
      // By default preserve existing tuned config/weights — only update metadata.
      // Set force_config: true on a lens entry to also overwrite its config/signal_filters.
      const updateData = { name: dbCfg.name, description: dbCfg.description, category: dbCfg.category };
      if (force_config) { updateData.config = dbCfg.config; if (dbCfg.version) updateData.version = dbCfg.version; }
      await prisma.lensConfig.update({ where: { slug: dbCfg.slug }, data: updateData });
      updated++;
      console.log(`  ↑ Updated${force_config ? ' (config overwritten)' : ' metadata'}: ${dbCfg.slug}`);
    } else {
      await prisma.lensConfig.create({ data: dbCfg });
      created++;
      console.log(`  + Created: ${dbCfg.slug}`);
    }
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
