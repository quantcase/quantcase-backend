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
    version:      '1.11.0',
    config: {
      signal_filters: {
        signal_types:        ['milestone', 'governance', 'kpi'],
        include_historical:  true,
      },
      kpi_filter: 'milestone_metrics_only',
      weights: [
        { metric: 'guidance_given',       w: 0.5 },
        { metric: 'guidance_missed',      w: -0.8 },
        { metric: 'proactive_disclosure', w: 0.3 },
      ],
      aggregation:     'weighted_sum',
      balance:         { default: 9999 },
      model:           HAIKU,
      max_tokens:      32000,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured guidance-credibility view. Do NOT invent data — work only from the signals provided.

TODAY'S DATE: 2026-06-04

---

STEP 1 — READ THE L1 SIGNALS CAREFULLY BEFORE WRITING ANYTHING

Each signal in the DATA_BLOCK contains at minimum:
  - announcement_date:     the quarter management made this statement (e.g. "Q3 FY22") — WHEN the commitment was made
  - value_at_announcement: the actual metric value at the time management made the statement (what things looked like when they said it)
  - value_targeted:        the number management committed to achieving
  - target_date:           the deadline they set for achieving the target (e.g. Q4 FY25) — WHEN it must be achieved by
  - actual_value:          the number actually reported for that same deadline period (null if not yet reported)
  - actual_date:           the period the actual result belongs to

announcement_date and target_date are TWO DIFFERENT FIELDS and can be years apart.
  - announcement_date = Q3 FY22 (management spoke on this date)
  - target_date       = Q4 FY25 (management said this target will be met by this date)
  Read both independently. Never confuse them.

actual_value and value_targeted are also TWO DIFFERENT FIELDS and will frequently differ.
  Do NOT copy value_targeted into actual_value. Read each field independently from the signal.

If actual_value is null → period not yet reported → direction = "tracking".
If actual_value is non-null → use it exactly to compute delta and direction.

---

STEP 2 — COMPUTE DELTA FOR EVERY RESOLVED EVENT

delta = actual_value − value_targeted

This number will frequently be non-zero. A flat delta (delta = 0) should be rare — only when actual literally equals the target to the digit. If you are producing mostly flat deltas, you are echoing value_targeted as actual_value — stop and re-read the signals.

DELTA RULES:
- Populate delta ONLY when target_date ≤ 2026-06-04 AND actual_value is confirmed non-null
- If target_date > 2026-06-04: OMIT delta and delta_pct entirely (do not include these fields)
- delta_pct = (delta / value_targeted) × 100, rounded to 1 decimal place

---

STEP 3 — DIRECTION TAGGING (strictly enforced)

1. target_date > 2026-06-04 → direction = "tracking" regardless of anything else
2. target_date ≤ 2026-06-04 AND actual_value is null → direction = "tracking"
3. target_date ≤ 2026-06-04 AND actual_value is confirmed:
   - delta_pct > +2%  → direction = "beat"
   - delta_pct < −2%  → direction = "miss"
   - −2% ≤ delta_pct ≤ +2% → direction = "in_line"

direction must NEVER be null. Every timeline signal must be one of: beat / miss / in_line / tracking.

---

STEP 4 — PERIOD-MATCHING (strictly enforced)

The actual_value used to evaluate any guidance event MUST come from the EXACT same period as target_date.
- "15% loan growth by Q3 FY25" → only Q3 FY25 actuals count. Not Q4 FY25, not FY25 full year.
- "NIM of 4.2% for FY25" → only full-year FY25 actuals count. Not Q4 FY25.
- If the exact period's actual is not in the signals → actual_value = null → direction = "tracking"
- Never substitute or approximate from a nearby period.

---

STEP 5 — REVISION TRACKING (same metric, multiple commitments)

Management often guides the same metric multiple times across different quarters, sometimes revising targets up or down. Each distinct commitment is a SEPARATE row — do not collapse them.

Example: NIM guided on Q3 FY22 (target: 4.5% by FY25) and then revised on Q2 FY24 (target: 4.2% by FY25) → emit both rows. This lets the reader see the original commitment, the revision, and what actually happened.

Deduplication rule: only collapse if announcement_date, metric, AND target_date are all identical.

How to label revisions in the statement:
- Original commitment: write normally
- Revised commitment: start with "Revised guidance:" so the reader can see it was a change

---

STEP 6 — DEDUPLICATION

Same metric + different target_date = SEPARATE rows. Always.
Same metric + same target_date but different announcement_date = SEPARATE rows (revision).
Only collapse if metric, target_date, AND announcement_date are all truly identical.

---

STEP 7 — LIFECYCLE CLASSIFICATION (encoded in the direction field)

The "direction" field carries both the numeric outcome AND the management behaviour signal.
Extended direction values for guidance-credibility timeline rows:

  "beat"
    — Promise made, target_date passed, actual_value exceeded value_targeted (+2% or more)
    — Management acknowledged the delivery in a subsequent call

  "in_line"
    — Promise made, target_date passed, actual_value within ±2% of value_targeted
    — Management acknowledged the outcome

  "miss"
    — Promise made, target_date passed, actual_value fell short by more than 2%
    — Management acknowledged the shortfall, revised the target, or explained the gap in a subsequent call
    (Most honest failure mode — credit-worthy for transparency even though they missed)

  "promise_silently_dropped"  ← NEW extended value
    — Promise made, target_date has passed
    — actual_value fell short OR no actual was ever reported
    — No later signal shows management revisiting, revising, or acknowledging this commitment
    — Management simply stopped talking about it
    MOST DAMAGING pattern — use this instead of "miss" when the failure was never acknowledged.
    Always add a note in the statement field: "No subsequent acknowledgment found."

  "tracking"
    — Promise made, target_date has NOT yet passed (after 2026-06-07)
    — Still live, outcome not yet assessable

DECISION TREE for direction assignment:
  1. target_date > 2026-06-07                          → "tracking"
  2. target_date ≤ 2026-06-07 AND actual confirmed:
       delta_pct > +2%                                 → "beat"
       -2% ≤ delta_pct ≤ +2%                           → "in_line"
       delta_pct < -2% AND acknowledged by management  → "miss"
       delta_pct < -2% AND NOT acknowledged            → "promise_silently_dropped"
  3. target_date ≤ 2026-06-07 AND no actual found:
       subsequent signal acknowledges / revises        → "miss"
       no acknowledgment found                         → "promise_silently_dropped"

---

STEP 8 — SIGNAL PRIORITY HIERARCHY (apply when selecting timeline rows)

Not all trackable signals are equal. Prioritize in this strict order:

  TIER 1 — Multi-quarter trackable commitments (MUST include ALL available, up to the 20-signal cap):
  A signal where management made a specific, measurable promise on one announcement_date and the
  target_date is at least 2 quarters later. These span fiscal years or several quarters.
  Examples:
    • "Jio subscribers to cross 500M by FY26" — announced Q1 FY24, target FY26 (8 quarters later)
    • "KG-D6 first gas by mid-2020" — announced Q3 FY19, target Q1 FY21 (6 quarters later)
    • "Retail stores to reach 10,000 by Dec 2019" — announced Q4 FY19, target Q3 FY20
  These are the most valuable signals for guidance credibility — they reveal whether management
  sets long-range targets and then delivers. Include ALL of them, ordered oldest announcement_date first.

  TIER 2 — Single-quarter forward guidance (include after all Tier 1, within the 20-signal cap):
  A signal with a target_date in the immediately following quarter or within 1 quarter of announcement.
  Examples: "We expect to add 25 stores next quarter", "NIM should improve by 10bps next quarter".
  Include these only after all Tier 1 signals have been included.

  TIER 3 — Success disclosures (DO NOT emit as timeline rows — EXCLUDE entirely):
  Statements reporting what happened in the SAME quarter as the announcement — achievements, records,
  accomplishments with no forward commitment. These are facts, not guidance.
  Examples:
    • "Jio reached 160M subscribers this quarter" — fact, not a commitment
    • "GRM at a 7-year high this quarter" — fact disclosure, no target
    • "We opened 813 new stores in Q2" — achievement report, not a forward promise
  DO NOT emit these as timeline rows even if the signal has an end_date matching the same quarter.
  Use them only as supporting context when computing the HEADLINE signals.

ORDERING RULE: Within each tier, apply this secondary sort:
  1. Hard-metric signals first — signal has a numeric value_targeted (e.g. "500M subscribers", "30 MMSCMD gas", "18% loan growth"). These are the most trackable and most meaningful for credibility scoring.
  2. Binary milestone signals second — signal has a target_date but no numeric target (e.g. "demerger by November", "first gas by mid-2020"). Still trackable but directional only.
  3. Soft/directional signals last — signal uses only vague language like "will improve", "expect to grow", "near-term improvement", "medium-term target" with no concrete number attached. These add little analytical value. If the 20-signal cap is reached and only soft signals remain, drop them — do not fill slots with vague talk.

Within each sub-group above, sort by announcement_date oldest first.

---

{{DATA_BLOCK}}

---

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this exact layout. No exceptions.

  HEADLINE SIGNALS (positions 0–2, mandatory):

  [0] metric: "HEADLINE_HIT_RATE"
      label: fraction of RESOLVED events that beat or came in_line, e.g. "5/7"
        — numerator: count of resolved events where direction = beat or in_line
        — denominator: count of ALL resolved events (target_date ≤ 2026-06-04 with confirmed actual)
      statement: one sentence listing which key metrics hit and which missed (≤80 chars, use metric names)
      actual_value: numerator
      value_targeted: denominator
      unit: "ratio"
      impact: "high"

  [1] metric: "HEADLINE_MAJOR_MISS"
      label: short name of the biggest resolved miss with its delta, e.g. "NIM −40bps"
      statement: "Targeted [X] for [period] (announced in [announcement_date]) — came in at [Y], shortfall of [Z]." (≤90 chars, all numbers)
      actual_value: the actual_value of the missed metric
      value_targeted: the value_targeted of the missed metric
      unit: appropriate unit
      direction: "major_miss"
      impact: "high"
      — If no material resolved miss: label = "No Major Miss", actual_value = 0, direction = "beat"

  [2] metric: "HEADLINE_GUIDANCE_BIAS"
      label: "Conservative" | "Balanced" | "Mixed" | "Aggressive"
        — Conservative: management regularly guides below what they deliver (beats dominate)
        — Aggressive: management regularly guides above what they deliver (misses dominate)
        — Balanced: roughly equal beats and misses
        — Mixed: no clear pattern
      statement: one sentence with the beat/miss count split to justify the label (≤80 chars)
      impact: "high"

  TIMELINE SIGNALS (positions 3 onward — one row per QUALIFYING guidance commitment, up to 20 total):

  QUALIFYING CRITERIA — a signal must meet ALL THREE to get a timeline row:
    1. Management made a specific, measurable commitment (a number, a milestone, a date, a rate)
    2. The signal has a target_date (end_date in the data block) OR an explicit time_horizon
    3. The commitment is trackable — you can determine whether it was met, missed, or is still pending

  SELECTION ORDER — fill slots 3 to 22 (max 20 signals) strictly in this priority:
    First: ALL Tier 1 signals (multi-quarter commitments, oldest announcement_date first)
    Then:  Tier 2 signals (single-quarter guidance) until the 20-signal cap is reached

  DO NOT emit timeline rows for:
    - Operational achievements reported as facts (e.g. "506M subscribers this quarter")
    - Product launches or partnerships with no stated target or deadline
    - General strategy statements without measurable outcomes
    - Success disclosures of past events with no forward commitment (Tier 3)
  These belong only as evidence in HEADLINE fields — not as individual timeline rows.

  Each row = one specific commitment management made on a specific announcement_date about a specific target_date.

  • signal_id:         copy the [id=...] value exactly from the DATA_BLOCK
  • metric:            the financial metric (e.g. "NIM", "LOAN_GROWTH", "ROA", "CD_RATIO")
  • label:             target period, e.g. "FY25", "Q3 FY26" (max 10 chars) — this is the target_date period
  • announcement_date: the quarter management made this commitment, e.g. "Q3 FY22" — copy from signal exactly

  • statement: ONE sentence. Must contain four facts: (1) what was targeted, (2) the number, (3) the deadline, (4) the actual result with its number. Format: "[Metric] targeted at [X] by [period] (announced [announcement_date]) — [period] came in at [Y]."
    STATEMENT RULES — non-negotiable:
    - Always include announcement_date so the reader knows how old the commitment was.
    - Use the actual targeted number (value_targeted). Never paraphrase as "strong growth" or "healthy levels".
    - Use the actual reported number (actual_value). Never substitute words like "delivered", "achieved", "on track".
    - Both value_targeted AND actual_value must appear. No exceptions.
    - If actual is not yet reported: end with "— [period] result not yet reported."
    - For revised guidance: start statement with "Revised in [announcement_date]:"
    - Max 100 chars. No arrows. No semicolons. One fact only.

    ✅ CORRECT:  "NIM targeted at 4.2% by FY25 (announced Q3 FY22) — FY25 came in at 3.8%."
    ✅ CORRECT:  "Loan growth targeted at 18% by FY26 (announced Q1 FY24) — FY26 came in at 21%."
    ✅ CORRECT:  "ROA targeted at 1.8% by FY27 (announced Q2 FY25) — FY27 result not yet reported."
    ✅ CORRECT:  "Revised in Q2 FY24: NIM targeted at 4.0% by FY25 — FY25 came in at 3.8%."
    ❌ WRONG:    "Guided strong loan growth for FY26 — delivered in FY26."
    ❌ WRONG:    "Guided NIM improvement — achieved as guided."
    ❌ WRONG:    "Guided loan growth matching system — on track so far."
    ❌ WRONG:    Any statement missing either value_targeted or actual_value.

  • value_at_announcement: the actual metric value at the time management made the statement. OMIT this field entirely when not available. Never use 0 as a placeholder.
  • value_targeted: the numeric target from the signal. OMIT this field entirely — do NOT include it — when no numeric target exists (e.g. binary milestones like "demerger will happen in November"). Never use 0 or "undefined" as placeholders.
  • actual_value:   the numeric result for the exact same period. OMIT this field entirely when not yet reported or not applicable. Never use 0 as a placeholder.
  • unit:           "%" | "Cr" | "bps" | "x" | "million" | "stores" | "timing" (for date-based milestones); OMIT this field entirely when no unit applies
  • delta:          actual_value − value_targeted. OMIT this field entirely whenever value_targeted or actual_value is absent. Never use 0 as a placeholder delta.
  • delta_pct:      (delta / value_targeted) × 100 rounded to 1dp. OMIT this field entirely whenever delta is absent.
  • direction:      one of beat / in_line / miss / promise_silently_dropped / tracking — apply Step 3 + Step 7 decision tree exactly. Use "promise_silently_dropped" when a past-deadline commitment was never acknowledged by management.
  • target_date:    ISO 8601 last day of the target period (e.g. 2025-03-31 for FY25)
  • announcement_date: quarter of the commitment, e.g. "Q3 FY22"
  • actual_date:    ISO 8601 last day of the reported period (same as target_date if unreported)
  • impact:         "high" | "medium" | "low"
  • original_statement: copy the EXACT sentence from the DATA_BLOCK signal that this row is sourced from. Do NOT paraphrase. If the signal has no source sentence, set to null.

  SUMMARY SIGNAL (last position, after all timeline signals):
  metric: "HEADLINE_ENTRY_COUNT"
  • label: "N entries" where N = total count of timeline signals emitted (max 20)
  • statement: what the timeline spans (earliest announcement_date to latest target_date) in ≤60 chars
  • impact: "high"

---

WRITING RULES (non-timeline fields):
- "takeaway": max 25 words. Lead with hit rate (e.g. "6/9 resolved") and bias label. No filler.
- "highlights": up to 3 items, max 15 words each, start with a verb or metric name, include numbers.
- "risks": up to 2 items, max 12 words each, start with the risk noun, include numbers where possible.
- Never pad. Never use vague qualifiers where numbers exist.

---

SELF-CHECK before emitting JSON:
1. Does any field contain the string "undefined"? That is NEVER valid JSON — remove the field entirely instead.
2. Is any value_targeted or actual_value set to 0 as a placeholder for "unknown"? Remove the field entirely instead. 0 means the actual number zero.
3. Is any delta set to 0 for a resolved event where value_targeted and actual_value are both present and different? Re-read — you may be echoing value_targeted as actual_value.
4. When value_targeted or actual_value is absent, is delta also absent (not 0)? If delta is present as 0 but one side is missing, remove delta entirely.
5. Does any statement lack a targeted number (value_targeted, for numeric commitments)? Rewrite it.
6. Does any statement lack an actual number (actual_value, for resolved events)? Rewrite it.
7. Does every timeline signal include announcement_date? If not — add it.
8. Are there multiple commitments for the same metric to the same deadline? Split into separate rows.
9. Does every timeline signal have a non-null direction? If not — fix it.
10. Do beat/miss counts in HEADLINE_HIT_RATE match the direction tags in timeline signals? Recount.
11. Does every timeline signal have an original_statement that is a verbatim copy from the DATA_BLOCK? If paraphrased or invented, replace with the exact source sentence.
12. Are there hard-metric Tier 1 signals (numeric value_targeted, multi-quarter span) that were skipped in favour of soft/directional signals? If so, swap them in — hard metrics always take priority over soft talk.
13. For every past-deadline signal (target_date before 2026-06-07) tagged "miss" — is there actually evidence of management acknowledging the miss? If not, change direction to "promise_silently_dropped" and add "No subsequent acknowledgment found." to the statement.

---

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words>,
  "key_metrics": {},
  "highlights": [<up to 3 items>],
  "risks": [<up to 2 items>],
  "top_signals": [<HEADLINE_HIT_RATE, HEADLINE_MAJOR_MISS, HEADLINE_GUIDANCE_BIAS, ...up to 20 timeline signals (Tier 1 oldest-first, then Tier 2)..., HEADLINE_ENTRY_COUNT>]
}

`,
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
  • guided_date: period end date in YYYY-MM-DD
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
    version:     '1.5.0',
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

top_signals[] — include 8–12 signals. ALL must have non-null actual_value.
The "metric" field MUST be the exact canonical identifier from the tables below — it is used directly as a database lookup key.

  BFSI — include ALL available in this exact order:
    metric: "NIM_PCT"        | label: "Net Interest Margin"       | unit: "%"
    metric: "REV_OP"         | label: "Interest Revenue"          | unit: "Cr"
    metric: "TOTAL_INCOME"   | label: "Total Revenue"             | unit: "Cr"
    metric: "LOAN_ADV_TOTAL" | label: "Loan / Advances"           | unit: "Cr"
    metric: "DEP_TOTAL"      | label: "Total Deposits"            | unit: "Cr"
    metric: "CASA"           | label: "CASA Ratio"                | unit: "%"
    metric: "ROA"            | label: "Return on Assets"          | unit: "%"
    metric: "GNPA"           | label: "Gross NPA Ratio"           | unit: "%"
    metric: "NPA"            | label: "Net NPA Ratio"             | unit: "%"
    metric: "PAT"            | label: "Profit After Tax"          | unit: "Cr"
    metric: "TOTAL_OPEX"     | label: "Operating Expenses"        | unit: "Cr"
    Secondary (include if data available):
    metric: "ROE"            | label: "Return on Equity"          | unit: "%"
    metric: "EPS_BASIC"      | label: "Earnings Per Share"        | unit: "₹"
    metric: "CFO"            | label: "Operating Cash Flow"       | unit: "Cr"

  Non-BFSI — include ALL available in this exact order:
    metric: "REV_OP"         | label: "Operating Revenue"          | unit: "Cr"
    metric: "EBITDA"         | label: "EBITDA"                     | unit: "Cr"
    metric: "EBITDA_MARGIN"  | label: "EBITDA Margin"              | unit: "%"
    metric: "PAT"            | label: "Profit After Tax"           | unit: "Cr"
    metric: "PAT_MARGIN"     | label: "PAT Margin"                 | unit: "%"
    metric: "CFO"            | label: "Operating Cash Flow"        | unit: "Cr"
    metric: "CAPEX"          | label: "Capital Expenditure"        | unit: "Cr"
    metric: "DEBT_LT"        | label: "Long-Term Debt"             | unit: "Cr"
    metric: "DEBT_ST"        | label: "Short-Term Debt"            | unit: "Cr"
    metric: "DE"             | label: "Debt / Equity"              | unit: "x"
    metric: "ROCE"           | label: "Return on Capital Employed" | unit: "%"
    metric: "ROE"            | label: "Return on Equity"           | unit: "%"
    Secondary (include if data available):
    metric: "EPS_BASIC"      | label: "Earnings Per Share"         | unit: "₹"
    metric: "IC"             | label: "Interest Coverage"          | unit: "x"
    metric: "TRADE_RECV"     | label: "Trade Receivables"          | unit: "Cr"
    metric: "INVENTORY"      | label: "Inventory"                  | unit: "Cr"

  For each signal:
  • metric: MUST be the exact identifier from the table above — do NOT use free-form names from the data block
  • label: use the exact label from the table above
  • actual_value: numeric value (non-null) — use the MOST RECENT period value available
  • unit: use the exact unit from the table above
  • direction: "beat" if improving YoY, "miss" if deteriorating, "in_line" if stable, "tracking" if forward-looking
  • impact: "high" for the 4 most important signals for this sector, "medium" for next tier, "low" for supporting
  • actual_date: ISO 8601 date YYYY-MM-DD of the period end — MUST reflect the latest period in the data block
  • guided_value: management guidance if available, else null
  • guided_date: guidance target date if available, else null

  • statement: ≤80 chars — STRICT FORMAT RULES (pick the best pattern that applies):
      PATTERN A — Cross-signal derived insight (preferred when two metrics can be combined):
        Examples: "CFO/PAT 88% — near-full cash conversion" | "Recv. +38.8% vs Rev +12.1% — WC stress" | "ROCE 54% on zero debt — capital-lite model" | "No equity dilution; EPS CAGR 18% FY20–25"
      PATTERN B — Latest period fact + YoY delta (when no cross-signal insight applies):
        Examples: "₹206 Cr CFO in FY25, up 43% YoY" | "DE 0.00x — debt-free through full cycle" | "EPS ₹29 in FY26-Q4, flat YoY"
      PATTERN C — Trend with period anchors (for multi-year directional moves):
        Examples: "EBITDA margin 38→44% over FY22–25" | "ROCE compressing: 54%→42% FY18→FY23"
      RULES:
        - ALWAYS reference the latest available period (e.g. "FY25", "FY26-Q4") — NEVER use old periods like FY15/FY16 as the anchor
        - NEVER just restate the label ("PAT grew consistently") — must include a number
        - NEVER use generic history summaries like "consistent growth to X by FY21"
        - For ratios/derived insights: state the ratio value and what it implies (e.g. "88% cash conversion" not just "high CFO")

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the dominant financial strength or weakness verdict — reference the latest period.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric — latest period numbers only.
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
  "top_signals": [<8–12 signals per priority tables above; metric MUST be the exact canonical identifier from the table (e.g. "NIM_PCT", "REV_OP", "PAT"); each signal has: metric, label, actual_value (non-null numeric), unit, direction, impact, statement, actual_date, guided_value, guided_date>]
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
    version:      '1.5.0',
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
Build a 3-column (Bull / Base / Bear), 5-row scenario matrix. Rows: Industry Growth CAGR (3Y), Company Revenue CAGR (3Y), Margin Assumption, EPS/PAT CAGR (3Y), Analyst View. For every number include a one-line "because" rationale.

1. Industry Growth CAGR (3Y) — Use historical industry CAGR from signals as the base anchor. Express as a single % number for each scenario.
   Bull: Historical CAGR × 1.15–1.3 (sector tailwinds).
   Base: Historical CAGR (steady-state).
   Bear: Historical CAGR × 0.6–0.8 (demand slowdown).

2. Company Revenue CAGR (3Y) — Adjust from industry CAGR for market share, guidance, and order book.
   Bull: Industry CAGR + market share gain. Express as a low–high % range (e.g. "12–14") or single %.
   Base: Management-guided revenue growth. Express as a low–high % range or single %.
   Bear: Industry CAGR − market share loss. Express as a low–high % range or single %.

3. Margin Assumption — Use last-4-quarter average EBITDA_MARGIN as the base. Express as absolute EBITDA margin % for each scenario (e.g. 22.5 for 22.5%). Never use bps — always use absolute %.

4. EPS/PAT CAGR (3Y) — Project via the revenue/margin/tax waterfall. Express as a single signed % number.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order. Used for the Analyst View row.
  highlights[0]: "Bull: <narrative of up to 25 words explaining the bull scenario drivers>"
  highlights[1]: "Base: <narrative of up to 25 words explaining the base scenario>"
  highlights[2]: "Bear: <narrative of up to 25 words explaining the bear scenario risks>"

takeaway — MUST include ALL THREE price ranges in ₹X–₹Y format in this order, then risk/reward:
  1. Bull-case 3-year target price range (highest values).
  2. Base-case 3-year target price range (middle values).
  3. Bear-case 3-year target price range (lowest values).
  4. Risk/reward ratio as Nx immediately followed by "risk/reward" (e.g. "1.9x risk/reward").
  Example: "Bull ₹520–₹580, Base ₹420–₹480, Bear ₹280–₹340. RTM +37% YoY drives 18% PAT CAGR. 1.9x risk/reward."

top_signals[] — ALL signals MUST have non-null actual_value. MANDATORY layout (in this exact order):

  ── INDUSTRY GROWTH SIGNAL (1 signal, required) ──
  metric: "INDUSTRY_GROWTH_BASE", unit: "%"
  • actual_value: base-case industry CAGR (numeric only, e.g. 9). NEVER a word.
  • label: short sector descriptor, e.g. "Industry Revenue CAGR"
  • statement: one sentence on sector context (≤80 chars)
  • direction: "tracking" | "beat" | "miss"

  ── SCENARIO SIGNALS (9 signals, ALL required) ──
  Emit EXACTLY these 9, in this order. ALL must have non-null actual_value. No exceptions.

  [1]  metric: "SCENARIO_BULL_INDUSTRY_GROWTH", unit: "%"
       actual_value: bull-case industry CAGR (e.g. 10.8). label: "Bull Industry Growth"

  [2]  metric: "SCENARIO_BASE_INDUSTRY_GROWTH", unit: "%"
       actual_value: base-case industry CAGR (e.g. 9.0). label: "Base Industry Growth"

  [3]  metric: "SCENARIO_BEAR_INDUSTRY_GROWTH", unit: "%"
       actual_value: bear-case industry CAGR (e.g. 6.3). label: "Bear Industry Growth"

  [4]  metric: "SCENARIO_BULL_REV_CAGR_LOW", unit: "%"
       actual_value: bull-case company revenue CAGR low end (e.g. 12). label: "Bull Rev CAGR Low"
  [5]  metric: "SCENARIO_BULL_REV_CAGR_HIGH", unit: "%"
       actual_value: bull-case company revenue CAGR high end (e.g. 14). label: "Bull Rev CAGR High"
       — If a single value (not a range), set both LOW and HIGH to the same number.

  [6]  metric: "SCENARIO_BASE_REV_CAGR_LOW", unit: "%"
       actual_value: base-case company revenue CAGR low end (e.g. 7). label: "Base Rev CAGR Low"
  [7]  metric: "SCENARIO_BASE_REV_CAGR_HIGH", unit: "%"
       actual_value: base-case company revenue CAGR high end (e.g. 9). label: "Base Rev CAGR High"
       — If single value, set both to same number.

  [8]  metric: "SCENARIO_BEAR_REV_CAGR_LOW", unit: "%"
       actual_value: bear-case company revenue CAGR low end (e.g. 2). label: "Bear Rev CAGR Low"
  [9]  metric: "SCENARIO_BEAR_REV_CAGR_HIGH", unit: "%"
       actual_value: bear-case company revenue CAGR high end (e.g. 4). label: "Bear Rev CAGR High"
       — If single value, set both to same number.

  [10] metric: "SCENARIO_BULL_MARGIN_PCT", unit: "%"
       actual_value: bull-case EBITDA margin as absolute % (e.g. 22.5). label: "Bull EBITDA Margin"
       direction: "beat"

  [11] metric: "SCENARIO_BASE_MARGIN_PCT", unit: "%"
       actual_value: base-case EBITDA margin as absolute % (e.g. 19.0). label: "Base EBITDA Margin"
       direction: "in_line"

  [12] metric: "SCENARIO_BEAR_MARGIN_PCT", unit: "%"
       actual_value: bear-case EBITDA margin as absolute % (e.g. 16.5). label: "Bear EBITDA Margin"
       direction: "miss"

  [13] metric: "SCENARIO_BULL_EPS_CAGR", unit: "%"
       actual_value: bull-case 3Y PAT/EPS CAGR % (e.g. 18). label: "Bull EPS CAGR"
       statement: one-line EPS driver (≤60 chars). direction: "beat"

  [14] metric: "SCENARIO_BASE_EPS_CAGR", unit: "%"
       actual_value: base-case 3Y PAT/EPS CAGR % (e.g. 12). label: "Base EPS CAGR"
       statement: one-line EPS context (≤60 chars). direction: "in_line"

  [15] metric: "SCENARIO_BEAR_EPS_CAGR", unit: "%"
       actual_value: bear-case 3Y PAT/EPS CAGR % (e.g. -3). label: "Bear EPS CAGR"
       statement: one-line EPS risk (≤60 chars). direction: "miss"

  VALIDATION — count your SCENARIO_* signals before outputting. You MUST have exactly 15 (indices 1–15).
  Any null actual_value is a hard failure — go back and compute it using the scenario matrix arithmetic.

  ── SUPPORTING FINANCIALS (4–6 signals after the scenario block) ──
  Include the most recent values for: REV_OP, EBITDA_MARGIN (or PBDIT_MARGIN), PAT, and optionally CAPEX, DEBT_LT, EPS_BASIC.
  All must have non-null actual_value.

WRITING STYLE RULES:
- "takeaway": max 35 words, MUST include bull/base/bear ₹X–₹Y ranges and Nx risk/reward.
- "highlights": Bull:/Base:/Bear: prefix + narrative up to 25 words.
- "risks": max 12 words each, start with risk noun.
- "statement" in signals: ≤80 chars.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — bull ₹X–₹Y, base ₹X–₹Y, bear ₹X–₹Y, Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] "Bull: ...", highlights[1] "Base: ...", highlights[2] "Bear: ...">],
  "risks": [<up to 2 concerns, max 12 words, starting with risk noun>],
  "top_signals": [<INDUSTRY_GROWTH_BASE; then 15 SCENARIO_* signals [1–15]; then 4–6 supporting financials — ALL non-null actual_value>]
}`,
    },
  },
  {
    slug:         'earning-quality',
    name:         'Earning Quality',
    category:     'deal',
    description:  'EPS growth trajectory and quality — company vs industry, beat rate, consistency score, and growth trend over rolling 5-year window',
    force_config: true,
    version:      '1.4.0',
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

Your task is to synthesise this signal summary into a structured earnings quality view. Do NOT invent company financial data — work only from the signals provided. You MAY use sector knowledge to estimate industry benchmarks where not present in signals.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — the service computes company CAGR, YoY growth bars, and outperformance from Prowess timeseries. You only need to supply what the service CANNOT compute:

  REQUIRED SIGNALS (emit all 6, all with non-null actual_value):

  [0] metric: "EPS_CAGR_INDUSTRY"
      unit: "%"
      actual_value: industry/sector trailing 5Y EPS CAGR — a NUMERIC value, e.g. -13.4. Estimate from sector knowledge if not in signals. Must not be null.
      label: "Industry EPS CAGR (5Y)"
      statement: ≤80 chars — source or basis (e.g. "Indian IT sector composite, 2 peers")

  [1] metric: "EPS_GROWTH_ESTIMATE"
      unit: "%"
      actual_value: forward 1Y EPS/PAT growth estimate as a NUMBER (e.g. 5.5). Use management guidance or consensus estimate. Must not be null.
      guided_value: management-guided figure if explicitly stated, else null.
      label: "FY25E EPS Growth (Est.)"  (or FY26E if more current)
      statement: ≤80 chars — basis for estimate

  [2] metric: "EPS_BEAT_RATE"
      unit: "yrs"
      actual_value: integer — number of years (out of last 5–6) where company EPS/PAT growth beat industry. E.g. 5 means "beat 5 of 6 years". Must not be null.
      total_periods: integer — total periods evaluated (denominator), e.g. 6.
      label: "Beat Industry X of Y Yrs"  (fill X and Y with actual numbers)
      statement: ≤80 chars — brief characterisation of beat consistency

  [3] metric: "EPS_CONSISTENCY_SCORE"
      unit: "/5"
      actual_value: integer 0–5 — quality/consistency score: 5=highly consistent positive growth, 0=highly erratic or declining. Use PAT/EPS trend consistency, beat rate, and volatility.
      label: "Growth Consistency"
      status: one of "Strong" | "Moderate" | "Weak"
      statement: ≤80 chars — key factor driving the score

  [4..N] metric: "INDUSTRY_GROWTH_PERIOD" — one entry per year matching the company bar chart window (4–6 entries).
      unit: "%"
      actual_value: industry EPS growth for that year (numeric, signed). Estimate from sector knowledge if needed.
      label: same period label as the company bar (e.g. "FY20", "FY21") — must match what the service emits for the bars.
      actual_date: period end date YYYY-MM-DD (used for chart x-axis alignment).

  INSIGHT CARD SIGNALS (emit 4 — one per bottom card):
  [N+1] metric: "INSIGHT_BEAT_RATE"
        actual_value: same integer as EPS_BEAT_RATE.actual_value
        label: short headline ≤40 chars, e.g. "Beat industry 5 of 6 years"
        statement: ≤80 chars description shown under the headline card
        status: "Positive" | "Neutral" | "Negative"

  [N+2] metric: "INSIGHT_CAGR_ASSESSMENT"
        label: short headline ≤40 chars describing the 5Y CAGR finding
        statement: ≤80 chars — 1-sentence explanation (e.g. "Base effect drag from FY21 trough reduces CAGR")
        status: "Positive" | "Watch" | "Negative"

  [N+3] metric: "INSIGHT_FORWARD_ESTIMATE"
        label: short headline ≤40 chars, e.g. "FY25E recovery — 5.5% growth est."
        statement: ≤80 chars — context for the forward estimate
        status: one of "Positive" | "Stable" | "Negative"

  [N+4] metric: "INSIGHT_CONSISTENCY"
        label: short headline ≤40 chars, e.g. "Growth Consistency — Moderate"
        statement: ≤80 chars — key driver of consistency assessment
        status: one of "Strong" | "Moderate" | "Weak"

WRITING STYLE RULES:
- "takeaway": max 25 words, action-oriented, lead with the key finding.
- "highlights" items: max 12 words each, start with a verb or metric.
- "risks" items: max 12 words each, start with the risk noun.
- "statement" in top_signals: ≤80 chars, evidence-based, no padding phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words>],
  "top_signals": [EPS_CAGR_INDUSTRY, EPS_GROWTH_ESTIMATE, EPS_BEAT_RATE, EPS_CONSISTENCY_SCORE, then INDUSTRY_GROWTH_PERIOD entries (one per year), then INSIGHT_BEAT_RATE, INSIGHT_CAGR_ASSESSMENT, INSIGHT_FORWARD_ESTIMATE, INSIGHT_CONSISTENCY]
}`,
    },
  },
  {
    slug:         'pe-rerating-potential',
    name:         'P/E Re-Rating Potential',
    category:     'deal',
    description:  'Likelihood of multiple expansion driven by improving fundamentals, guidance clarity, and sector tailwinds',
    force_config: true,
    version:      '1.5.0',
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

Your task is to synthesise this signal summary into a structured P/E re-rating view that powers a frontend dashboard. All numeric fields in top_signals MUST be actual numbers — never null, never text.

VALUATION ANALYSIS CONSTRUCTION:
Perform the following reasoning steps before composing the JSON output:

1. IDENTIFY SECTOR — Infer sector from available signals (e.g. AUM/NIM/GNPA → NBFC/Banking; EBITDA/order book → Capital Goods; gross margin >50% → FMCG/Consumer). Use sector to anchor P/E norms.

2. SECTOR P/E ANCHOR (mandatory — use these ranges):
   Banking/NBFC:      Bear 8–14x  | Base 14–20x  | Bull 20–28x
   Capital Goods:     Bear 18–26x | Base 26–36x  | Bull 36–50x
   FMCG/Consumer:     Bear 28–38x | Base 38–52x  | Bull 52–70x
   IT Services:       Bear 16–22x | Base 22–30x  | Bull 30–42x
   Pharma/Healthcare: Bear 18–26x | Base 26–36x  | Bull 36–50x
   Auto/Auto Ancil:   Bear 12–18x | Base 18–26x  | Bull 26–36x
   Default (generic): Bear 12–18x | Base 18–26x  | Bull 26–38x

3. QUALITY ADJUSTMENT — Apply ROE premium/discount to the sector anchor:
   ROE >20%: shift all ranges +2x. ROE 15–20%: no adjustment. ROE <15%: shift all ranges −2x.
   Strong PAT growth trajectory (>20% CAGR): shift Bull range +2x further.
   Governance red flags or guidance misses: shift Bear range −2x.

4. RE-RATING TAG — Based on PAT growth, ROE trajectory, and catalyst strength, assign: Strong / Moderate / Weak.

5. RETURN ESTIMATION — Estimate implied returns from current valuation:
   If CMP is available from signals, compute: Return = (FutureEPS × ExitPE − CMP) / CMP × 100.
   If no CMP: estimate returns directionally from P/E expansion/compression vs sector norm.
   Bear return: typically −10% to −30%. Base return: 10%–30%. Bull return: 30%–70%.

6. NARRATIVE SCORE — assign an integer 0–100 reflecting re-rating momentum:
   Strong re-rating potential + improving fundamentals → 70–90.
   Neutral / fair-valued → 40–60.
   De-rating risk dominant → 10–35.

7. CATALYSTS — identify the 2–3 strongest positive drivers and 1–2 biggest downside risks.
   Each catalyst needs a short title (3–6 words, title-case) and a one-sentence explanation (max 80 chars).

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

takeaway — first sentence (before the first ".") must be a 2–4 word actionable headline:
  e.g. "Re-rating candidate." / "Premium multiple justified." / "Execution watch needed." / "De-rating risk elevated."
  Subsequent sentences provide supporting detail.

highlights[] — exactly 3 items, fixed order:
  [0] Bull catalyst — single strongest re-rating driver. Max 20 words.
  [1] Base narrative — primary fundamental supporting current valuation. Max 20 words.
  [2] Bear risk — single biggest de-rating risk. Max 20 words.

top_signals[] — emit ALL signals below, in this order. EVERY numeric field is REQUIRED (no nulls).

  FUNDAMENTALS (3 signals):
  [0] { metric: "ROA",  unit: "%",  actual_value: <number>, label: "Return On Assets",  statement: "<≤80 chars>" }
  [1] { metric: "ROE",  unit: "%",  actual_value: <number>, label: "Return On Equity",  statement: "<≤80 chars>" }
  [2] { metric: "PAT",  unit: "Cr", actual_value: <number>, label: "Net Profit",         statement: "<≤80 chars>" }

  SCENARIO P/E RANGES (3 signals — actual_value = low end, guided_value = high end, both REQUIRED as numbers):
  [3] { metric: "SCENARIO_BEAR_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Bear Case P/E", impact: "high", statement: "<bear thesis ≤80 chars>" }
  [4] { metric: "SCENARIO_BASE_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Base Case P/E", impact: "high", statement: "<base thesis ≤80 chars>" }
  [5] { metric: "SCENARIO_BULL_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Bull Case P/E", impact: "high", statement: "<bull thesis ≤80 chars>" }

  SCENARIO RETURNS (3 signals — actual_value = low end %, guided_value = high end %, both REQUIRED):
  [6] { metric: "SCENARIO_BEAR_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Bear Return",   impact: "high", statement: "<≤80 chars>" }
  [7] { metric: "SCENARIO_BASE_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Base Return",   impact: "high", statement: "<≤80 chars>" }
  [8] { metric: "SCENARIO_BULL_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Bull Return",   impact: "high", statement: "<≤80 chars>" }

  SCENARIO NARRATIVES (3 signals — the "What happens?" text for each scenario card):
  [9]  { metric: "SCENARIO_BEAR_WHAT_HAPPENS", statement: "<2 sentences: what causes de-rating and what investors feel>", label: "Bear What Happens" }
  [10] { metric: "SCENARIO_BASE_WHAT_HAPPENS", statement: "<2 sentences: base case outcome and market narrative>",        label: "Base What Happens" }
  [11] { metric: "SCENARIO_BULL_WHAT_HAPPENS", statement: "<2 sentences: bull catalyst and re-rating trigger>",           label: "Bull What Happens" }

  NARRATIVE PANEL (2 signals):
  [12] { metric: "NARRATIVE_SCORE", actual_value: <integer 0-100>, label: "<3–6 word narrative label, e.g. 'Defensive quality, growth laggard'>", statement: "<1-sentence description of what would shift the narrative positively>" }
  [13] { metric: "NARRATIVE_LABEL", label: "<same 3–6 word label as NARRATIVE_SCORE>", statement: "<same 1-sentence shift description>" }

  POSITIVE CATALYSTS (2–3 signals, metric = "CATALYST_POSITIVE_1", "CATALYST_POSITIVE_2", "CATALYST_POSITIVE_3"):
  { metric: "CATALYST_POSITIVE_1", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_POSITIVE_2", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_POSITIVE_3", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }  ← omit if only 2 catalysts

  NEGATIVE CATALYSTS (1–2 signals, metric = "CATALYST_NEGATIVE_1", "CATALYST_NEGATIVE_2"):
  { metric: "CATALYST_NEGATIVE_1", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_NEGATIVE_2", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }  ← omit if only 1

CONCRETE EXAMPLE — IT Services company, ROE ~22%, moderate growth:
  SCENARIO_BEAR_PE_RANGE: actual_value=16, guided_value=20
  SCENARIO_BASE_PE_RANGE: actual_value=22, guided_value=27
  SCENARIO_BULL_PE_RANGE: actual_value=28, guided_value=35
  SCENARIO_BEAR_RETURN:   actual_value=-15, guided_value=-5
  SCENARIO_BASE_RETURN:   actual_value=8,   guided_value=20
  SCENARIO_BULL_RETURN:   actual_value=25,  guided_value=45
  NARRATIVE_SCORE:        actual_value=62
  CATALYST_POSITIVE_1:    label="AI Monetization at Scale", statement="..."
  CATALYST_NEGATIVE_1:    label="Structural Growth Slowdown", statement="..."

VALIDATION — before outputting, confirm:
  ✓ All 9 scenario signals present (3 PE_RANGE + 3 RETURN + 3 WHAT_HAPPENS)
  ✓ Every actual_value and guided_value in PE_RANGE and RETURN signals is a number (not null, not a string)
  ✓ NARRATIVE_SCORE.actual_value is an integer 0–100
  ✓ At least 2 CATALYST_POSITIVE and 1 CATALYST_NEGATIVE signals present

WRITING STYLE:
- statement fields: ≤80 chars, factual, no filler phrases.
- label fields: 2–6 words, title-case.
- Never write "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — 2–4 word headline first sentence, then supporting detail>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3: bull catalyst, base narrative, bear risk>],
  "risks": [<1–2 concerns, max 12 words each, starting with risk noun>],
  "top_signals": [<all signals in order: ROA, ROE, PAT, 3×PE_RANGE, 3×RETURN, 3×WHAT_HAPPENS, NARRATIVE_SCORE, NARRATIVE_LABEL, CATALYST_POSITIVE_1..3, CATALYST_NEGATIVE_1..2>]
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
