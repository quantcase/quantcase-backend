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
    version:      '1.3.0',
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

TODAY'S DATE: 2026-06-04

GUIDANCE TIMELINE CONSTRUCTION:
Review each guidance event in the signals. For each, determine: what was guided (guided_value + guided_date), what was actually delivered (actual_value), and whether the result is beat / miss / in_line / tracking. Identify the single most important RESOLVED miss as "major miss". Assess overall directional bias (Conservative / Balanced / Aggressive) based on resolved events only.

DEDUPLICATION RULE — Same metric, different periods = SEPARATE rows (required).
Example: CD_RATIO FY25, CD_RATIO FY26, CD_RATIO FY27 are three distinct guidance events — emit all three.
Only collapse entries if the metric AND the time period are truly identical.

DIRECTION TAGGING RULES — strictly enforced:
1. If guided_date > 2026-06-04 (target deadline has NOT yet passed): direction = "tracking". NEVER "miss" for future targets.
2. If guided_date ≤ 2026-06-04 AND actual_value is available:
   - Beat: outperformed the guidance materially
   - in_line: within ±2% relative tolerance of guided value
   - miss: materially underdelivered vs guidance
3. "miss" is ONLY valid when: (a) guided_date ≤ 2026-06-04 AND (b) actual_value confirms underdelivery.

DELTA RULES — strictly enforced:
- Populate delta (= actual_value − guided_value) ONLY when BOTH:
  (a) guided_date ≤ 2026-06-04 (the milestone deadline has been reached or passed)
  (b) actual_value is non-null and confirmed
- If guided_date > 2026-06-04: set delta = 0 and delta_pct = 0 (use 0, not omit).

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this exact layout. No exceptions.

  HEADLINE SIGNALS (positions 0–2, mandatory, consumed positionally by the UI):
  These render as the 3 headline strip tiles at the top. ALL THREE are required.

  [0] metric: "HEADLINE_HIT_RATE"
      label: fraction string counting ONLY RESOLVED events (guided_date ≤ 2026-06-04), e.g. "5/7"
      statement: one sentence naming which metrics beat/missed among resolved events (≤80 chars)
      actual_value: count of hits among resolved events (numerator)
      guided_value: total count of resolved guidance events (denominator)
      unit: "ratio"
      impact: "high"
      (omit direction — not applicable for this tile)

  [1] metric: "HEADLINE_MAJOR_MISS"
      label: short descriptor of the biggest RESOLVED miss, e.g. "NIM −12%" or "HDB IPO"
      statement: what was guided, what was delivered, and the reset if any (≤80 chars)
      actual_value: delta as a signed number (e.g. -12 for a 12% shortfall)
      unit: "%" (or appropriate unit for that metric)
      direction: "major_miss"
      impact: "high"
      (If no material resolved miss exists, set label: "No Major Miss", actual_value: 0, direction: "beat")

  [2] metric: "HEADLINE_GUIDANCE_BIAS"
      label: "Conservative" | "Balanced" | "Mixed" | "Aggressive"
      statement: one sentence explaining the directional pattern (≤80 chars)
      impact: "high"
      (omit direction — not applicable for this tile)

  TIMELINE SIGNALS (positions 3 onward, one per guidance event):
  Emit ALL guidance events — both resolved (past) and pending (future). Each is a separate row.
  • signal_id: id of the source signal from the DATA_BLOCK (copy the [id=...] value exactly)
  • metric: the financial metric being guided (e.g. "CD_RATIO", "LOAN_GROWTH", "ROA", "NIM")
  • label: period identifier, e.g. "FY25", "FY27", "Q3 FY26" (max 10 chars)

  PERIOD-MATCHING RULE — strictly enforced, no exceptions:
  The actual_value used to evaluate any guidance event MUST come from the EXACT same period that management specified as the target deadline. 
  - If management guided "15% loan growth by Q3 FY25", you must look up the loan growth figure reported FOR Q3 FY25 specifically — not Q4 FY25, not FY25 full year, not any adjacent period.
  - If management guided a full-year target (e.g. "NIM of 4.2% for FY25"), the actual must be the full-year FY25 reported figure — not a quarterly figure.
  - If the exact period's actual is not available in the signals, set actual_value = guided_value (placeholder) and direction = "tracking". Do NOT substitute a different period's actual.
  - Never infer, interpolate, or approximate from a nearby period. Period mismatch = no verdict.

  • statement: A single plain-English sentence written as a track record entry. It must answer three questions in one breath: (1) what did management commit to, (2) by when, and (3) did they deliver — where "deliver" is checked against the same period's actual, not any other.

    STATEMENT RULES — strictly enforced:
    - Write in simple, direct English. No arrows (→), no semicolons, no jargon.
    - Always state the guided target as a number or range. If management only gave a qualitative target (e.g. "in line with system"), you must still find and state the numeric benchmark — do not repeat the qualitative phrase.
    - Always name the exact period management gave.
    - Always state the actual result as a number. NEVER use words like "delivered", "achieved", "in line", "on track" as substitutes for a number.
    - If the actual number for that exact period is not available in the signals, end with "— [period] actual not available."
    - For resolved hits: "[Guided X% for FY2X — came in at Y%.]"
    - For resolved misses: "[Guided X% for FY2X — came in at Y%.]" (same format; direction field carries the hit/miss verdict, not the statement)
    - For pending: "[Guided X% by FY2X — result not yet reported.]"
    - Max 90 chars. One thought only. No filler.

    Good examples:
      Resolved hit:  "Guided NIM at 4.2% for FY25 — came in at 4.4%."
      Resolved miss: "Guided NIM at 4.2% for FY25 — came in at 3.8%."
      Pending:       "Guided ROA at 1.8% by FY27 — result not yet reported."
      No actual:     "Guided loan growth at 15% for FY26 — FY26 actual not available."
      IPO miss:      "Guided HDB Financial IPO by Sept 2025 — not completed by Sept 2025."

    Bad examples (never do this):
      "Guided loan growth in line with system for FY26 — delivered in FY26."
      "Guided faster-than-system growth — on track so far."
      "Guided CD ratio to healthy levels — achieved."

  • actual_value: realized value from THE EXACT SAME PERIOD as guided_date; if that period is not yet reported use guided_value as placeholder
  • guided_value: management's forward commitment (numeric)
  • unit: "%" or "Cr" or appropriate unit
  • delta: apply DELTA RULES above — use 0 for future targets
  • delta_pct: percentage delta — use 0 if delta is 0
  • direction: MUST be non-null; apply DIRECTION TAGGING RULES above strictly
  • guided_date: ISO 8601 last day of the guidance target period
  • actual_date: ISO 8601 last day of the reported period (use guided_date if not yet reported)
  • impact: "high" | "medium" | "low"

  SUMMARY SIGNALS (emit at the end, after all timeline signals):
  metric: "HEADLINE_ENTRY_COUNT"
  • label: total count of ALL timeline signals as "N entries", e.g. "8 entries"
  • statement: short description of what the timeline covers (≤60 chars)
  • impact: "high"
  (omit direction — not applicable)

WRITING STYLE RULES:
- "statement" in TIMELINE signals: follow the STATEMENT RULES above exactly. Plain, direct, track-record style. No arrows, no semicolons.
- "takeaway": max 25 words, lead with hit rate fraction (resolved events only) and bias verdict.
- "highlights": up to 3 items, max 15 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "label" in top_signals: 2–8 chars for period labels, or short descriptor for headlines.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with hit rate and bias verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<[0] HEADLINE_HIT_RATE, [1] HEADLINE_MAJOR_MISS, [2] HEADLINE_GUIDANCE_BIAS — all required; then timeline signals at [3+] one per guidance event with non-null direction and delta=0 for future targets; then HEADLINE_ENTRY_COUNT>]
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

SECTOR CONSTRAINT — NIM signals:
  NIM (Net Interest Margin) is a BFSI-specific metric (banks, NBFCs, HFCs, MFIs). Do NOT generate NIM-related signals, bullets, callouts, or commentary for non-BFSI companies. If the subject company is not in the BFSI sector, skip any NIM references entirely.

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
    version:     '1.1.0',
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens, including individual company signals AND industry-level aggregate metrics from the PEER CONTEXT block below.

Your task is to synthesise this data into a structured industry view. Do NOT invent data — work only from the signals and peer context provided.

SECTOR DETECTION — check the PEER CONTEXT block header. If it contains "[BFSI]", this is a BFSI industry (bank, NBFC, HFC, MFI, insurance, AMC). Apply the BFSI tile layout below. Otherwise apply the Non-BFSI tile layout.

{{DATA_BLOCK}}

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the industry structural finding (e.g. "Industry revenue compounding at 10.8% CAGR; margin pressure from input costs — watch copper pass-through lag.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "Industry OPM at 8.9%, down 180bps YoY on copper drag.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Greenfield capacity idle at 36% — fixed-cost dilution risk.")
- "label" in top_signals: 2–5 words, title-case, human-readable (e.g. "Industry Revenue", "3Y Revenue CAGR")
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

top_signals[] — MUST follow this exact positional layout. Positions 0–3 are FIXED INDUSTRY KPI TILES consumed positionally by the UI — ALL four MUST be present with non-null actual_value sourced from the PEER CONTEXT "Industry Aggregates" block.

  ── NON-BFSI FIXED INDUSTRY KPI TILES (use when PEER CONTEXT does NOT contain [BFSI]):
  • [0] metric: "INDUSTRY_REVENUE", unit: "Cr", actual_value: Total Industry Revenue (REV_OP) from PEER CONTEXT. label: "Industry Revenue". direction: "beat"|"miss"|"in_line"|"tracking" based on YoY trend if available, else "tracking".
  • [1] metric: "INDUSTRY_REV_CAGR_3Y", unit: "%", actual_value: Avg 3Y Revenue CAGR from PEER CONTEXT. label: "3Y Revenue CAGR". direction: "beat" if >12%, "in_line" if 8–12%, "miss" if <8%.
  • [2] metric: "INDUSTRY_OPM", unit: "%", actual_value: Avg Industry OPM (EBITDA_MARGIN) from PEER CONTEXT. label: "Industry OPM". direction: "beat" if expanding YoY, "miss" if contracting, else "tracking".
  • [3] metric: "INDUSTRY_ROCE", unit: "%", actual_value: Weighted Avg Industry ROCE from PEER CONTEXT. label: "Industry ROCE". direction: "beat" if >15%, "in_line" if 10–15%, "miss" if <10%.

  ── BFSI FIXED INDUSTRY KPI TILES (use ONLY when PEER CONTEXT contains [BFSI]):
  • [0] metric: "INDUSTRY_ROA", unit: "%", actual_value: Avg Industry ROA from PEER CONTEXT "Avg Industry ROA". label: "Industry ROA". direction: "beat" if >1.5%, "in_line" if 1–1.5%, "miss" if <1%.
  • [1] metric: "INDUSTRY_NIM", unit: "%", actual_value: Avg Industry NIM from PEER CONTEXT "Avg Industry NIM". label: "Industry NIM". direction: "beat" if >3.5%, "in_line" if 2.5–3.5%, "miss" if <2.5%.
  • [2] metric: "INDUSTRY_AUM", unit: "Cr", actual_value: Total Industry AUM from PEER CONTEXT "Total Industry AUM". label: "Industry AUM". direction: "beat" if growing YoY, "miss" if declining, else "tracking". (If AUM is N/A, use Total Industry Loan/Advances instead and set label: "Industry Loan Book".)
  • [3] metric: "INDUSTRY_REV_CAGR_3Y", unit: "%", actual_value: Avg 3Y Revenue CAGR from PEER CONTEXT. label: "3Y Revenue CAGR". direction: "beat" if >15%, "in_line" if 10–15%, "miss" if <10%.

  MANAGEMENT CONSENSUS SIGNALS (positions 4–7, mandatory — derived from management commentary in the signal data block):
  • [4] metric: "MGMT_DEMAND_BULLISH_COUNT", unit: "transcripts", actual_value: count of company transcripts in the data block showing bullish demand signals (volume growth, order book expansion, positive guidance). label: "Demand: Bullish Signals".
  • [5] metric: "MGMT_DEMAND_TOTAL_COUNT", unit: "transcripts", actual_value: total count of company transcripts in the data block that mention demand. label: "Demand: Total Signals".
  • [6] metric: "MGMT_SUPPLY_TIGHT_COUNT", unit: "transcripts", actual_value: count of company transcripts in the data block showing tight supply or capacity pressure signals. label: "Supply: Tight Signals".
  • [7] metric: "MGMT_SUPPLY_TOTAL_COUNT", unit: "transcripts", actual_value: total count of company transcripts in the data block that mention supply or capacity. label: "Supply: Total Signals".

  DEMAND DRIVERS (positions 8+): include up to 5 individual demand signals from the data block, each with actual_value, unit, and statement. Use "tracking" direction for forward-looking signals, "beat"/"miss" for actuals vs prior period.
  SUPPLY SIGNALS (after demand drivers): include up to 5 individual supply/cost pressure signals from the data block.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, action-oriented industry structural synthesis>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive industry findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [
    {
      "signal_id": <string — id of the signal from the data block, or "peer_context" for PEER CONTEXT-derived values>,
      "metric": <string — metric name exactly as specified above>,
      "label": <string — 2–5 word title-case human-readable label>,
      "guided_value": <number | null>,
      "guided_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "actual_value": <number | null — MUST be non-null for positions 0–7>,
      "actual_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "unit": <string | null>,
      "delta": <number | null>,
      "delta_pct": <number | null>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — key evidence quote, ≤80 chars>
    }
  ]
}`,
    },
  },
  {
    slug:        'competition',
    name:        'Competition',
    category:    'opportunity',
    description: 'Market moat, pricing power, and competitive differentiation vs peers',
    force_config: true,
    version:     '1.1.0',
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens, plus a PEER CONTEXT block with industry aggregate and individual peer KPIs (Revenue, 3Y CAGR, OPM, ROCE, EPS) sourced from audited financials.

Your task is to assess the subject company's competitive position, moat quality, pricing power, and entry barriers relative to its industry peers. Do NOT invent data — work only from the signals and peer context provided.

{{DATA_BLOCK}}

PORTER'S SCORE CALCULATION (score out of 10):
Assess each of the 5 forces and assign 0–2 points each:
  1. Competitive Rivalry (0=intense, 2=low): based on peer count, market share concentration, OEM switching cost signals.
  2. Supplier Power (0=high, 2=low): based on raw material cost signals, commodity exposure, pass-through ability.
  3. Buyer Power (0=high, 2=low): based on customer concentration, OEM dependency, long-term programme locks.
  4. Threat of New Entrants (0=high, 2=low): based on capex moat, certifications/qualifications, technology barriers.
  5. Threat of Substitutes (0=high, 2=low): based on technology disruption signals (EV, imports), powertrain shift.
Sum these for the Porter's Score (0–10). State each sub-score in the statement for PORTERS_SCORE signal.

PEER TABLE CONSTRUCTION:
From the PEER CONTEXT block, identify the subject company and its closest 2–4 named peers. For each, extract:
  - REV_OP (Cr), REV_GROWTH_YOY (%), EBITDA_MARGIN (%), ROCE (%), DE (ratio), MKT_SHARE_PCT (% = peer REV_OP / total industry REV_OP × 100).
Include an Industry Avg row using the industry aggregates from PEER CONTEXT.
Encode each peer as one PEER_ROW_* signal.

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, lead with market share vs growth vs moat finding (e.g. "+25.5% revenue vs 4% PV market growth — share gains visible; ex-greenfield margins hold at 11.3%")
- "highlights" items: max 12 words each, start with a verb or metric
- "risks" items: max 12 words each, start with the risk noun
- "label" in top_signals: 2–5 words, title-case
- "statement" in top_signals: ≤80 chars, evidence or sub-score breakdown
- Never pad with filler phrases

top_signals[] — MUST follow this exact positional layout. The frontend consumes positions 0–3 as KPI tiles, 4–7 as competitive cards, and 8+ as peer table rows.

  COMPETITIVE KPI TILES (positions 0–3, mandatory):
  • [0] metric: "MARKET_POSITION", unit: null.
      actual_value: signal count backing the assessment as a number (e.g. 3 means "3/3 signals").
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if Strong (market share above average + outperforming peers), "in_line" if Moderate, "miss" if Weak.
      label: "Market Position".
      statement: ≤80 chars — one-line evidence (e.g. "Dominant India wiring harness; 25.5% rev vs 4% PV growth").

  • [1] metric: "PRICING_POWER", unit: null.
      actual_value: signal count backing the assessment (e.g. 2 out of 3 = 2).
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if Strong, "in_line" if Moderate/Partial, "miss" if Weak.
      label: "Pricing Power".
      statement: ≤80 chars — evidence of pass-through ability or lack thereof (e.g. "Copper pass-through partial; timing lag compresses near-term margins").

  • [2] metric: "ENTRY_BARRIERS", unit: null.
      actual_value: signal count backing the assessment (e.g. 3).
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if High, "in_line" if Medium, "miss" if Low.
      label: "Entry Barriers".
      statement: ≤80 chars — moat source (e.g. "OEM quals, capex-intensive plants, 12–18 month requalification cycle").

  • [3] metric: "PORTERS_SCORE", unit: "/10".
      actual_value: Porter's Five Forces score (0–10, computed from rubric above).
      guided_value: 10.
      direction: "beat" if ≥7, "in_line" if 5–6, "miss" if ≤4.
      label: "Porter's Score".
      statement: ≤80 chars — sub-scores breakdown (e.g. "Rivalry 1/2 · Supplier 1/2 · Buyer 1/2 · Entry 2/2 · Sub 1/2").

  TILE VALIDATION (positions 0–3) — strictly enforced before output:
  • [0–2] guided_value MUST be a number (≥2, ≤5). It is the total signal count you assessed for that dimension. Never null, never undefined.
  • [3] guided_value MUST be exactly 10 (fixed constant). Never null.
  • direction MUST be non-null for all four tiles. Only "beat", "in_line", or "miss" are valid.
  If any of these are missing, go back and fill them before returning the JSON.

  COMPETITIVE SIGNAL CARDS (positions 4–7, mandatory — 2 strength signals then 2 risk/watch signals):
  • [4] metric: "COMP_STRENGTH_1" — primary moat or competitive advantage. direction: "beat". impact: "high".
      actual_value: numeric evidence (e.g. delta bps, %, Cr) if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case moat description (e.g. "Engine-Agnostic Platform Moat").
      statement: ≤80 chars, specific evidence (e.g. "ICE·hybrid·EV all covered; OEM requalification = 12–18 month moat").

  • [5] metric: "COMP_STRENGTH_2" — secondary advantage (balance sheet, share gain, cost structure). direction: "beat". impact: "medium".
      actual_value: numeric evidence if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case.
      statement: ≤80 chars evidence.

  • [6] metric: "COMP_RISK_1" — primary competitive risk or watch-out. direction: "miss". impact: "high".
      actual_value: numeric evidence (e.g. -90 for -90 bps, 6.7 for 6.7% share) if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case risk description (e.g. "EV Revenue Share Decline").
      statement: ≤80 chars evidence (e.g. "EV rev share 6.7% → 5.8% QoQ; OEM EV timeline slippage key watch-out").

  • [7] metric: "COMP_RISK_2" — secondary risk or sector comparison signal. direction: "miss" or "tracking". impact: "medium".
      actual_value: numeric evidence if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case.
      statement: ≤80 chars evidence.

  ROCE SPREAD SIGNAL (position 8, mandatory):
  • [8] metric: "ROCE_VS_INDUSTRY", unit: "bps".
      actual_value: the spread in basis points = (subject_ROCE_pct - industry_avg_ROCE_pct) × 100. Example: 38.7% - 16.1% = 22.6 percentage points = 2260 bps → actual_value: 2260. Always a plain integer bps number, never a percentage.
      guided_value: industry weighted average ROCE as a percentage (e.g. 16.1, not 1610). Plain decimal percent.
      delta: subject company ROCE as a percentage (e.g. 38.7, not 3872). Plain decimal percent.
      actual_date: last day of the latest reported fiscal year for subject ROCE (ISO 8601).
      direction: "beat" if spread >500bps, "in_line" if 0–500bps, "miss" if negative.
      label: "ROCE vs Industry Avg".
      statement: ≤80 chars — e.g. "MSUMI 38.7% vs industry 16.1% — 2,260bps spread above WACC".

  PEER TABLE ROWS (positions 9+, one signal per company including subject and named peers + industry avg row):
  Each peer row encodes one company's competitive metrics. Use metric name "PEER_ROW_{TICKER}" (e.g. "PEER_ROW_MSUMI", "PEER_ROW_MOTHERSON", "PEER_ROW_INDUSTRY_AVG").
  • signal_id: "peer_context"
  • metric: "PEER_ROW_{TICKER}" — use the NSE ticker or "INDUSTRY_AVG" for the average row
  • label: company display name (e.g. "MSUMI (Current)", "MOTHERSON", "Industry Avg")
  • actual_value: REV_OP in Cr
  • unit: "Cr"
  • guided_value: ROCE% (encode as guided_value so UI can render it in the ROCE% column)
  • guided_date: null
  • delta: EBITDA_MARGIN% (encode as delta so UI can render it in the OPM% column)
  • delta_pct: D/E ratio (encode as delta_pct so UI can render it in the D/E column)
  • direction: "beat" if subject company (is_subject), "in_line" for peers, "tracking" for industry avg row
  • impact: "high" for subject, "medium" for named peers, "low" for industry avg
  • statement: "REV_GROWTH={x}%|MKT_SHARE={y}%" — pipe-separated key=value pairs the UI can parse for the Rev Growth and Mkt Share columns

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with revenue vs market growth delta and moat finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive competitive findings, each max 12 words>],
  "risks": [<up to 2 competitive risks, each max 12 words, starting with risk noun>],
  "top_signals": [
    {
      "signal_id": <string — signal id from data block, or "peer_context" for PEER CONTEXT-derived values>,
      "metric": <string — metric name exactly as specified above>,
      "label": <string — as specified per position>,
      "guided_value": <number | null>,
      "guided_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "actual_value": <number | null>,
      "actual_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "unit": <string | null>,
      "delta": <number | null>,
      "delta_pct": <number | null>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — ≤80 chars>
    }
  ]
}`,
    },
  },
  {
    slug:        'financial-strength',
    name:        'Financial Strength',
    category:    'opportunity',
    description: 'Balance sheet strength, FCF generation, and margin quality',
    force_config: true,
    version:     '1.1.0',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'financial_health'],
        metric_family: ['profitability', 'capital', 'growth', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity', 'industry_specific'],
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured financial-strength view. Do NOT invent data — work only from the signals provided.

SECTOR DETECTION — determine whether this is a BFSI company (bank, NBFC, HFC, MFI, insurance, AMC) or a non-BFSI company by inspecting the signals. BFSI signals include: NIM, GNPA, NPA, CASA, LOAN_ADVANCES, DEPOSITS, INTEREST_INCOME, NII, PCR, CRAR, CAR, TIER1. Non-BFSI signals are dominated by EBITDA, CAPEX, WORKING_CAPITAL, INVENTORY, RECEIVABLES, COGS.

BFSI FINANCIAL STRENGTH FRAMEWORK (use when BFSI signals are present):
Assess across these dimensions:
  1. Margin Quality — NIM trajectory (expanding/compressing/stable), NII growth, cost-of-funds pressure.
  2. Asset Quality — GNPA%, NPA%, PCR trend, slippage ratio. Is the book cleaning up or deteriorating?
  3. Funding Franchise — Deposit growth, CASA ratio, cost-of-deposits. Is the liability franchise strong?
  4. Book Growth — Loan/Advances CAGR, AUM growth, disbursement trajectory. Is growth sustainable?
  5. Profitability & Efficiency — ROA, ROE, cost-to-income ratio, PAT trend.
  6. Capital Adequacy — CRAR/CAR/Tier-1 vs regulatory minimums.

NON-BFSI FINANCIAL STRENGTH FRAMEWORK (use when BFSI signals are absent):
Assess across these dimensions:
  1. Margin Quality — EBITDA margin trajectory and PAT margin. Operating leverage signals.
  2. Cash Generation — FCF (CFO − CAPEX), CFO/PAT conversion, working capital efficiency.
  3. Balance Sheet — Debt/Equity, interest coverage, net debt trajectory.
  4. Revenue Quality — Revenue growth, concentration, recurring vs one-off.
  5. Profitability — ROA, ROE, ROCE trends.
  6. Capex Cycle — CAPEX intensity, asset turns, growth vs maintenance capex.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

data_block PRIORITIZATION — when building top_signals, strictly prioritize these metrics by sector:

  BFSI priority order (include ALL available, in this order):
    1. NIM (Net Interest Margin)
    2. INTEREST_INCOME / NII (Interest Revenue / Net Interest Income)
    3. TOTAL_INCOME / REV_OP (Total Revenue)
    4. LOAN_ADVANCES / ADVANCES (Loan Book / Advances)
    5. DEPOSITS (Total Deposits)
    6. CASA / CASA_RATIO (CASA Ratio %)
    7. ROA (Return on Assets)
    8. GNPA / GNPA_RATIO (Gross NPA %)
    9. NPA / NET_NPA / NET_NPA_RATIO (Net NPA %)
    10. PAT (Profit After Tax)
    11. OPEX / COST_TO_INCOME (Operating Expenses / Cost-to-Income)
    Secondary (include if space): PCR, CRAR, ROE, TIER1, EPS, CFO

  Non-BFSI priority order:
    1. REV_OP / REVENUE (Operating Revenue)
    2. EBITDA / EBITDA_MARGIN (EBITDA & Margin %)
    3. PAT / PAT_MARGIN (PAT & Margin %)
    4. CFO (Operating Cash Flow)
    5. CAPEX (Capital Expenditure)
    6. DEBT_LT / DEBT_ST / DE (Debt levels & D/E ratio)
    7. ROA / ROE / ROCE (Return ratios)
    8. WORKING_CAPITAL / RECEIVABLE_DAYS / INVENTORY_DAYS (Efficiency)
    9. FCF (Free Cash Flow)
    10. EPS (Earnings per Share)

top_signals[] — include 8–12 signals. ALL must have non-null actual_value.
  For each signal:
  • metric: use the exact metric name from the data block
  • label: human-readable name (e.g. "Net Interest Margin", "Gross NPA Ratio", "Operating Revenue", "EBITDA Margin")
  • actual_value: numeric value (non-null)
  • unit: "%" for ratios/margins, "Cr" for absolute amounts, "x" for multiples
  • direction: "beat" if improving YoY, "miss" if deteriorating, "in_line" if stable, "tracking" if forward-looking
  • impact: "high" for the 4 most important signals for this sector, "medium" for next tier, "low" for supporting
  • statement: ≤80 chars — key context (YoY change, quarter, comparison vs guidance)
  • actual_date: ISO 8601 date YYYY-MM-DD of the period end
  • guided_value: management guidance if available, else null
  • guided_date: guidance target date if available, else null

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the dominant financial strength or weakness verdict.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with dominant financial strength/weakness verdict>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–12 signals; ALL must have non-null actual_value; BFSI: prioritise NIM, Interest Revenue, Total Revenue, Loan/Advances, Deposits, CASA, ROA, GNPA, NPA, PAT, OpEx in that order; Non-BFSI: prioritise Revenue, EBITDA, PAT, CFO, CAPEX, Debt, Return ratios>]
}`,
    },
  },
  {
    slug:        'customer-distribution',
    name:        'Customer & Distribution',
    category:    'opportunity',
    description: 'Client base growth, channel quality, and revenue concentration risk',
    force_config: true,
    version:     '1.2.0',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'customer', 'milestone'],
        metric_family:      ['customer'],
        include_historical: true,
      },
      weights: [
        { metric: 'REV_OP', w: 0.35, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured customer-and-distribution view. Do NOT invent data — work only from the signals provided.

CUSTOMER & DISTRIBUTION FRAMEWORK — assess across 5 dimensions:

  1. Customer Base Size & Growth — Total customer count, active users, subscriber count, client additions. Is the base growing, stable, or shrinking? What is the YoY growth rate?
  2. Revenue Mix & Segmentation — Business model breakdown: segment revenues (B2B vs B2C, domestic vs export, branded vs private label, product vs service), AUM/loan book/order book, contribution from top customers. Is revenue diversified or concentrated?
  3. Price-Volume Dynamics — Volume growth vs price/realization growth. Are revenue gains volume-led, price-led, or mix-led? Watch for realization compression or volume declines.
  4. Channel Quality & Reach — Outlet/retailer/dealer network size, expansion velocity, digital vs physical channel split, distribution depth (T1/T2/T3 cities, rural penetration). Are distribution investments driving incremental revenue?
  5. Customer Stickiness & Retention — Retention rate, repeat purchase rate, average ticket size trend, churn rate, NPS/CSAT score, cross-sell signals, revenue from existing vs new customers. Are customers being deepened or churning?

BUSINESS MODEL DETECTION — infer from signals:
  - If signals include AUM, SIP flows, loan book, disbursements → financial services / AMC / NBFC model
  - If signals include outlet count, retailer network, dealer expansion → FMCG / retail / auto distribution model
  - If signals include order book, project pipeline, client wins → B2B / capital goods / IT services model
  - If signals include subscriber count, paid users, engagement → consumer tech / media / telecom model
  Tailor your analysis language to match the detected model.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — include 8–12 signals. Prioritize in this order:
  1. CUSTOMER_COUNT / TOTAL_CUSTOMERS / ACTIVE_USERS / SUBSCRIBER_COUNT / CLIENT_BASE — customer base size (unit: number/mn/lakh)
  2. CUSTOMER_GROWTH / CUSTOMER_GROWTH_YOY / NEW_CUSTOMERS — customer addition rate (unit: %)
  3. Order book / AUM / loan book / disbursements — forward revenue visibility (unit: Cr/Mn)
  4. REV_OP or TOTAL_INCOME — total revenue anchor (unit: Cr)
  5. Segment revenue signals (SEG_* metrics) — business model mix (unit: Cr or %)
  6. OUTLET_COUNT / RETAILER_NETWORK / DEALER_COUNT / reach_outlets — distribution reach (unit: number)
  7. CHANNEL_EXPANSION / outlet additions / new geographies — distribution growth (unit: %)
  8. REVENUE_PER_CUSTOMER / AVG_TICKET_SIZE / AVERAGE_TICKET_SIZE / REALIZATION — monetisation depth (unit: ₹/Cr)
  9. REV_OP_GROWTH_YOY / SALES_GROWTH_RATE / ORGANIC_GROWTH — revenue growth rate (unit: %)
  10. CUSTOMER_RETENTION_RATE / retention_rate / LOYALTY_RATE — stickiness (unit: %)
  11. CUSTOMER_CONCENTRATION / top-customer revenue share — concentration risk (unit: %)
  12. CSAT_SCORE / NPS — satisfaction signals (unit: % or score)

  For each signal:
  • signal_id: id from the data block (or "derived" if computed)
  • metric: exact metric name from the data block
  • label: human-readable name (e.g. "Total Customers", "Order Book", "Retailer Network", "Avg Ticket Size", "Revenue Growth", "CASA Ratio")
  • actual_value: numeric value (non-null for all included signals)
  • unit: "%" for rates/shares, "Cr" for INR crores, "Mn" for millions, number for counts, "₹" for per-unit values
  • direction: "beat" if growing/positive trend, "miss" if declining/negative, "in_line" if stable, "tracking" if forward-looking guidance
  • impact: "high" for customer base size, order book/AUM, revenue mix; "medium" for channel reach, ticket size; "low" for satisfaction scores
  • statement: ≤80 chars — key context (YoY change, management commentary, comparison to guidance)
  • actual_date: ISO 8601 YYYY-MM-DD of the period end
  • guided_value: management target if available (e.g. customer count target, outlet expansion target), else null
  • guided_date: guidance target date if available, else null

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the dominant customer growth or distribution quality finding (e.g. "Customer base up 18% YoY; distribution reach growing via 3,200 new outlets — revenue concentration risk from top-3 accounts.")
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Concentration risk", "Churn rising", "Outlet productivity declining").
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with dominant customer growth or distribution quality verdict>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–12 signals; ALL must have non-null actual_value; prioritise: customer count/growth, order book/AUM, revenue segments, outlet/channel reach, ticket size/realization, revenue growth, retention, concentration risk>]
}`,
    },
  },
  // ── Deal lenses ──────────────────────────────────────────────────────────────
  {
    slug:         'earnings-forecast',
    name:         'Earnings Forecast',
    category:     'deal',
    description:  'Scenario-based earnings forecast — bull/base/bear EPS trajectory driven by revenue growth, margin expansion, and volume-mix dynamics',
    force_config: true,
    version:      '1.4.0',
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
   Bull: Margin expansion from operating leverage, pricing power, or lower input costs. Express as an absolute % level (e.g. "22%") OR a signed bps change (e.g. "+150bps").
   Base: Flat margins, in line with recent trend. Express as an absolute % level or "flat" with the current % (e.g. "flat 19%").
   Bear: Margin compression from cost pressure, lower utilisation, or competitive pricing. Express as a signed bps change (e.g. "-200bps") or absolute % level.

4. Earnings / PAT CAGR — Project using the waterfall:
   Future Revenue = Current REV_OP × (1 + Revenue CAGR)^3
   Future EBITDA  = Future Revenue × Scenario Margin %
   Future PAT     = Future EBITDA − Historical Interest (proxy: DEBT_LT × avg rate) − Depreciation (from signals) − Tax (effective rate from signals)
   PAT CAGR       = CAGR(Current PAT → Future PAT, 3Y)
   Show the arithmetic step-by-step in the "because" statement. If any input is unavailable, state the assumption explicitly.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order. Each highlight MUST embed three machine-readable tokens as a structured prefix before the narrative, using EXACTLY this format:
  "Bull: RevCAGR=X–Y%, Margin=<value>, EPS CAGR=Z%; <narrative>"
  "Base: RevCAGR=X–Y%, Margin=<value>, EPS CAGR=Z%; <narrative>"
  "Bear: RevCAGR=X–Y%, Margin=<value>, EPS CAGR=Z%; <narrative>"

  Token rules:
  • RevCAGR= — a % range or single % (e.g. "12–14%" or "8%"). Use the 3Y company revenue CAGR for that scenario.
  • Margin= — an absolute EBITDA margin % (e.g. "22%") OR a signed bps change from base (e.g. "+150bps", "-200bps") OR "flat <X>%" for base case. Always include a number.
  • EPS CAGR= — a single signed % figure (e.g. "15%", "-3%"). This is the 3Y PAT/EPS CAGR for that scenario.
  • Tokens are separated by ", " and the narrative follows after "; ".
  • Do NOT reorder or rename the tokens. The parser depends on prefix position.

  Examples (adapt values to the actual company):
  highlights[0]: "Bull: RevCAGR=12–14%, Margin=+150bps, EPS CAGR=18%; AI spend unlocks new demand driving market share and margin expansion."
  highlights[1]: "Base: RevCAGR=7–9%, Margin=flat 19%, EPS CAGR=11%; management guidance with steady volume growth and stable margins."
  highlights[2]: "Bear: RevCAGR=2–4%, Margin=-200bps, EPS CAGR=-3%; macro slowdown and wage inflation compress margins below operating leverage threshold."

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
- "takeaway": max 30 words, action-oriented, lead with the key finding.
- "highlights" items: structured prefix (RevCAGR=, Margin=, EPS CAGR=) followed by a concise narrative of up to 20 words.
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 30 words, MUST include bull ₹X–₹Y range, base ₹X–₹Y range, and Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items, each starting with "Bull:"/"Base:"/"Bear:" and containing RevCAGR=, Margin=, EPS CAGR= tokens before "; narrative">],
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
