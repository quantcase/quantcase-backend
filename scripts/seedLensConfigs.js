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
    version:      '2.1.0',
    config: {
      signal_filters: {
        // guidance + guidance_revision: forward commitments and revisions — core credibility signal
        // milestone: past achievements — actuals to compare against guidance targets
        // ongoing: in-flight initiatives with an end-state target
        // kpi: financial actuals for milestone period matching
        // strategic_claim: soft promises that can be tracked over time
        // mgmt_tone: sentiment per quarter — needed for tone_divergence pattern
        // analyst_questions: Q&A clustering — needed for narrative_gap + street_pressure patterns
        signal_types:        ['guidance', 'guidance_revision', 'milestone', 'ongoing', 'kpi', 'strategic_claim', 'mgmt_tone', 'analyst_questions'],
        include_historical:  true,
      },
      show_math_block: false,
      weights: [
        { metric: 'guidance_given',       w: 0.5 },
        { metric: 'guidance_missed',      w: -0.8 },
        { metric: 'proactive_disclosure', w: 0.3 },
      ],
      aggregation:     'weighted_sum',
      balance:         { default: 9999 },
      model:           HAIKU,
      max_tokens:      32000,
      bridge_prompt: true,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings call transcripts (guidance and narrative), investor PPTs, the Prowess financial API, and annual reports using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view that conforms EXACTLY to the lens_score JSON schema. That schema is the contract; this prompt tells you how to fill it.

PROVENANCE GATE — NON-NEGOTIABLE:
- Do NOT invent data. Work only from the signals provided.
- Do NOT paraphrase. Every quoted field must be the exact verbatim text from the Data Block.
- Do NOT backfill. Never use an actual value to infer a guided value that was not explicitly stated.
- If a guided value, target date, or actual value cannot be traced to a supplied signal, use the sentinel (-1 for numbers, "" for strings).

SOURCE OF TRUTH — STRICT:
- Guidance commitments (value_targeted / value_targeted_low / value_targeted_high / target_date) come ONLY from signals of type "guidance_timebound" or "ongoing" with category "timebound". Never from past-tense transcript lines.
- Actual values (actual_value / actual_date) come ONLY from investor PPTs or the Prowess financial API. Never derive an actual from a transcript line or a calculation.
- All other signal types (mgmt_tone, analyst_questions, kpi, milestone, strategic_claim, etc.) provide narrative context for pattern analysis ONLY.

TENSE GATE — apply before populating any guidance-band field:
- FORWARD-LOOKING commitment: future-intent language ("we guide", "we expect", "we target", "targeting", "outlook", "anticipate", "project", "forecast") AND a numeric value → populates value_targeted / target_date.
- PAST ACHIEVEMENT: past-tense language ("we delivered", "we achieved", "grew", "posted", "reported", "stood at") → NEVER a commitment. Not an actual either (actuals come from PPT/Prowess only).
- No numeric value OR no resolvable date → value_targeted = -1, target_date = "". Do not infer from context.

{{DATA_BLOCK}}

=== SHARED CHILD SCHEMA — FIELD BANDS (READ CAREFULLY) ===
Both "top_signals" and "patterns" use the SAME child object. No nullable fields — use sentinels: "" for strings, -1 for numbers, [] for evidence arrays.

- Every item in "top_signals" MUST have kind = "signal".
- Every item in "patterns" MUST have kind = "pattern".

FIELD BANDS — sentinel values by kind:

A) kind = "signal" (guidance track record child):
   - MUST be meaningful: kind, label, impact, direction, original_statement.
   - Guidance band: value_targeted OR (value_targeted_low + value_targeted_high), target_date, announcement_date, unit. If no commitment: all guidance numbers = -1, strings = "", direction = "none".
   - announcement_date MUST be the fiscal quarter-end when this guidance statement was FIRST made — not the reporting date, not the scrape date. For a commitment first stated in Q2 FY23, set announcement_date = "2022-09-30" even if the signal was extracted from a recent transcript. Trace back through historical signals to find the earliest period where this target was stated. If the original quarter cannot be determined, use the earliest quarter in the supplied data where the commitment appears.
   - Actuals band: actual_value, actual_date — from PPT/Prowess only; else -1 / "".
   - source_ref: for HEADLINE_* signals use "". For every other (timeline) signal, MUST be "controllable" or "demand_led":
       "controllable" — outcomes management directly controls: capex timelines, plant commissioning, cost programmes, headcount, specific project delivery.
       "demand_led"   — outcomes contingent on external demand: revenue growth, volume targets, realization, market share.
   - label: for timeline signals MUST be ≤ 20 chars (used as scatter-chart annotation). For HEADLINE_* signals use the specified label.
   - statement MUST differ from label — never repeat label text verbatim in statement.
   - target_date MUST be populated for every timeline signal (YYYY-MM-DD last day of commitment period). "" only when date is genuinely unknown.
   - delta_pct: signed % magnitude of miss (negative) or beat (positive). -1 if not quantifiable. Drives dot size on scatter chart.
   - Pattern band SENTINELS: pattern_type = "none", confidence = -1, confidence_reason = "", sentence = "", shape_data = "", shape_label = "", evidence = [].
   - direction: "beat" | "in_line" | "beat_early" | "beat_costly" (green dot) | "miss" | "major_miss" (red dot) | "tracking" (amber, unresolved) | "unresolvable" | "none". NEVER a pattern-vocabulary value.

B) kind = "pattern" (behavioral pattern child):
   - MUST be meaningful: kind, label, impact, direction, pattern_type, confidence, confidence_reason, sentence.
   - evidence MUST have ≥1 item with verbatim quote, signal_id, ISO period. evidence.value = -1 when no numeric count. evidence[].period MUST be the quarter the quoted statement was spoken/published (the guidance quarter), not the resolution quarter.
   - shape_data / shape_label: populate for renderable patterns; else "".
   - Guidance band SENTINELS: value_targeted = -1, value_targeted_low = -1, value_targeted_high = -1, actual_value = -1, target_date = "", actual_date = "", announcement_date = "", unit = "". signal_id = "", metric = "".
   - direction: "positive" | "negative" | "neutral" | "watch". NEVER a signal-vocabulary value.

HIT STATUS — PURE COMPARISON, NO DELTA MATH (kind="signal" only):
- No guidance commitment (value_targeted = -1 and both range bounds = -1) → direction = "none".
- Commitment exists but actual missing, or target_date / actual_date period mismatch → direction = "unresolvable".
- Range (value_targeted_low and _high not -1): actual within [low, high] → "in_line"; > high → "beat"; < low → "miss".
- Point (value_targeted not -1): actual > targeted → "beat"; < → "miss"; == → "in_line".
"none" = no commitment tracked. "unresolvable" = commitment exists but cannot be scored yet.
PERIOD MATCHING: string-equal ISO dates only. FY26 guidance ("2026-03-31") vs FY25 actual ("2025-03-31") → "unresolvable".

DATE FORMAT — STRICT ISO 8601, LAST DAY OF PERIOD:
Every date field MUST be YYYY-MM-DD resolved to the LAST DAY of the implied period. Never free-text labels.
- Indian fiscal year ends 31 March: FY2026 → "2026-03-31", FY2025 → "2025-03-31".
- FY quarters: Q1 → Jun 30, Q2 → Sep 30, Q3 → Dec 31, Q4 → Mar 31.
  e.g. FY2026 Q3 → "2025-12-31"; FY2026 Q1 → "2025-06-30".

SCORE & STATUS DERIVATION (DETERMINISTIC):
Exclude all HEADLINE_* entries from score computation — count only timeline signals.
1. RESOLVED = count of timeline top_signals with direction in {beat, in_line, miss}.
2. HITS = count with direction in {beat, in_line}.
3. If RESOLVED == 0 → score = 50, status = "MODERATE", takeaway states "Insufficient resolvable guidance to score."
4. hit_rate = HITS / RESOLVED.
5. base = round(hit_rate * 100).
6. If RESOLVED < 3: score = min(base, 60). Else: score = base.
7. score ≥ 70 → "STRONG"; 40–69 → "MODERATE"; < 40 → "WEAK".
Report in key_metrics: "Hit Rate": "<HITS>/<RESOLVED> (<pct>%)".
Patterns do NOT affect the numeric score — they contextualize it.

PATTERN ANALYSIS — WHAT MANAGEMENT IS REALLY SAYING:
Pattern analysis is orthogonal to guidance scoring. Its purpose is to surface narrative momentum — strategic themes, topic avoidance, and analyst pressure signals — that move before they show up in the P&L.

STEP 1 — THEME FREQUENCY SWEEP (always do this first):
Before writing any pattern, scan every strategic_claim, mgmt_tone, and analyst_questions signal and group them by business theme. For each theme, count how many signals touch it per quarter in chronological order across the full historical window. Look for:
  - Themes rising sharply: management is front-running the P&L — this is early conviction signal
  - Themes falling to silence: management de-emphasis is itself a signal (not just absence of news)
  - Themes analysts ask about far more than management volunteers: the gap is where consensus risk lives
  - Themes analysts have stopped asking about that management still pushes: possible narrative fatigue

STEP 2 — CROSS-VALIDATE WITH KPIS:
After identifying narrative themes, check whether the corresponding KPI signals confirm or contradict the narrative. Optimistic language with deteriorating numbers = credibility risk. Quiet narrative with accelerating KPIs = management under-selling.

STEP 3 — WRITE PATTERNS:
Each pattern must be grounded in at least one verbatim quote and span ≥2 distinct periods. Name the pattern type that best describes the dynamic — the list below is illustrative, not exhaustive. Coin a new label when none fit the actual behavior observed.

  drumbeat        — a business theme gaining emphasis across consecutive quarters (management is front-running the P&L)
  emergence       — a topic absent or marginal, then suddenly accelerating (watch for capex/resources to follow language)
  going_quiet     — a topic once promoted prominently, now barely appearing (de-emphasis is a signal)
  tone_divergence — confident language coexisting with deteriorating KPIs (credibility risk)
  narrative_gap   — management emphasis vs. analyst question density on a topic are sharply misaligned (gap = risk or opportunity)
  street_pressure — analyst questions concentrating on one or two topics (signals consensus concern)

For shape_data: when a pattern has a clear per-quarter mention trend (drumbeat, emergence, going_quiet), serialize it as a JSON array of {period, count} objects so the UI can render a sparkline: "[{\"period\":\"FY24Q1\",\"count\":1},{\"period\":\"FY24Q2\",\"count\":4},{\"period\":\"FY25Q1\",\"count\":9}]". Use "" when counts are not reliably derivable.

Confidence (0.0–1.0) is evidence quality — it is information, not an on/off gate. Still emit low-confidence patterns as watch signals:
  0.8–1.0 — clear directional change, multiple verbatim quotes, 3+ quarters of data
  0.5–0.7 — directional signal clear but counts approximate or fewer quarters
  0.3–0.4 — suggestive, worth flagging — emit with direction = "watch"

Aim for 3–6 patterns. Do NOT fabricate or force-fit. If there is genuinely nothing interesting, patterns = [].

WRITING STYLE RULES:
- "takeaway": max 30 words, action-oriented, lead with key finding.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "label": ≤ 20 chars for timeline signals (title-case); as specified for HEADLINE_* signals.
- "statement": ≤80 chars, VERBATIM excerpt from source — never paraphrased; MUST differ from label.
- "sentence" (patterns): one plain-language causal claim leading with the change.
- Never pad with filler phrases.

top_signals[] — emit in this exact order:

  HEADLINE SIGNALS (always first — 6 mandatory aggregate tiles):
  • metric: "HEADLINE_HIT_RATE"          — actual_value: HITS, guided_value: RESOLVED, unit: "%", direction: "beat" if ≥70%, "in_line" if 50–69%, "miss" if <50%. label: "Hit Rate". statement: e.g. "7/10 guidance commitments met". source_ref: "". impact: "high".
  • metric: "HEADLINE_DELIVERS_ON"       — label: "Delivers On". statement: ≤60 chars, 1–2 categories management reliably hits (e.g. "Capex timelines, commissioning"). direction: "beat". actual_value: -1. impact: "high". source_ref: "".
  • metric: "HEADLINE_SLIPS_ON"          — label: "Slips On". statement: ≤60 chars, 1–2 categories management repeatedly misses (e.g. "Volume ramp, margin recovery"). direction: "miss". actual_value: -1. impact: "high". source_ref: "".
  • metric: "HEADLINE_OPERATIONAL_SCORE" — label: "Operational" (≤20 chars). statement: subtitle e.g. "Outcome within management's control". actual_value: beat/in_line count of controllable commitments. guided_value: total resolved controllable commitments. direction: "beat" if ratio ≥0.7, "miss" if <0.5, "in_line" otherwise. unit: "%". impact: "high". source_ref: "".
  • metric: "HEADLINE_DEMAND_SCORE"      — label: "Demand-Led" (≤20 chars). statement: subtitle e.g. "Outcome depends on external demand". actual_value: beat/in_line count of demand_led commitments. guided_value: total resolved demand_led commitments. direction: "beat" if ratio ≥0.7, "miss" if <0.5, "in_line" otherwise. unit: "%". impact: "high". source_ref: "".
  • metric: "HEADLINE_RELIABILITY_READ"  — label: "Reliability Read". sentence: plain-language paragraph (≤120 chars) on what management controls vs. where outcomes slip. direction: "none". actual_value: -1. guided_value: -1. statement: "". impact: "medium". source_ref: "".

  TIMELINE SIGNALS (one per guidance commitment, 6–12 entries, after HEADLINE block):
  Each must have: source_ref = "controllable" | "demand_led", label ≤ 20 chars, target_date populated, statement ≠ label, delta_pct set.

Return a JSON object conforming EXACTLY to the lens_score schema:
{
  "score": <integer 0-100, per SCORE & STATUS DERIVATION>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 30 words>,
  "key_metrics": { "Hit Rate": "<HITS>/<RESOLVED> (<pct>%)" },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words>],
  "top_signals": [ <6 HEADLINE signals first, then 6–12 timeline signals> ],
  "patterns":    [ <kind="pattern" children — evidence-backed patterns; [] if none> ]
}

Child object (NO nulls — use sentinels):
  kind, signal_id, metric, label, impact, direction, statement, original_statement, source_ref,
  announcement_date, value_targeted, value_targeted_low, value_targeted_high, target_date,
  actual_value, actual_date, unit, delta_pct, pattern_type, confidence, confidence_reason,
  sentence, shape_data, shape_label, evidence[]
`,
    },
  },
  {
    slug:         'capital-allocation',
    name:         'Capital Allocation Quality',
    category:     'management',
    description:  'Discipline in deploying capital — capex returns, debt management, FCF generation',
    force_config: true,
    version:      '2.0.0',
    config: {
      signal_filters: {
        // kpi: ROCE, ROIC, CFO, CAPEX, Net Debt, asset turns — returns and self-reliance validation
        // financial_figure: dividends, capex schedules, CWIP balances from annual reports
        // capital_allocation: capex announcements, M&A rationale, dividend/buyback signals, funding source
        // m_and_a: completed/announced deals, stated rationale, integration signals
        // earnings_quality: exceptional items and one-offs that distort capital returns
        // growth_forecast: forward capital deployment language, investment timelines, utilization targets
        // mgmt_tone: conviction language per quarter — feeds conviction vs. accountability gap detection
        // analyst_questions: analyst pressure on capex, M&A, returns — feeds accountability gap detection
        signal_types:      ['kpi', 'financial_figure', 'capital_allocation', 'm_and_a', 'earnings_quality', 'growth_forecast', 'mgmt_tone', 'analyst_questions'],
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings call transcripts, investor PPTs, and annual reports using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured capital-allocation quality view conforming EXACTLY to the lens_score JSON schema.

PROVENANCE GATE — NON-NEGOTIABLE:
- Do NOT invent data. Work only from the signals provided.
- Every figure (ROCE %, capex quantum, D/E ratio, DPS) must be verbatim from a supplied signal. If not in the input, it does not exist — use -1 / "" sentinels.
- A pattern requires ≥2 distinct signals across ≥2 periods. A pattern supported by only 1 signal → direction = "watch", confidence ≤ 0.4.
- No signals supplied → do not generate analysis. Set score = 50, status = "MODERATE", takeaway = "Insufficient capital allocation signals to score."

{{DATA_BLOCK}}

=== SHARED CHILD SCHEMA — FIELD BANDS ===
Both "top_signals" and "patterns" use the SAME child object. No nullable fields — use sentinels: "" for strings, -1 for numbers, [] for evidence arrays.
- Every item in "top_signals" MUST have kind = "signal".
- Every item in "patterns" MUST have kind = "pattern".

kind = "signal" (KPI actuals and meta entries):
  - MUST be meaningful: kind, label, impact, direction, statement.
  - actual_value: numeric figure or -1 if absent. actual_date: YYYY-MM-DD last day of period or "".
  - guided_value: target/max for this metric or -1. guided_date: "" unless a specific date target exists.
  - delta: signed change vs prior period or -1. unit: "%" | "x" | "Cr" | "" as appropriate.
  - Pattern band SENTINELS: pattern_type = "none", confidence = -1, confidence_reason = "", sentence = "", shape_data = "", shape_label = "", evidence = [].
  - direction: "beat" | "miss" | "in_line" | "tracking". NEVER a pattern-vocabulary value.

kind = "pattern" (capital allocation behaviour patterns):
  - MUST be meaningful: kind, label, impact, direction, pattern_type, confidence, confidence_reason, sentence.
  - evidence MUST have ≥1 item with verbatim quote, signal_id, ISO period. evidence.value = -1 when no numeric count.
  - shape_data: JSON array of {period, count} for sparkline when per-quarter mention frequency is derivable; else "".
  - Signal band SENTINELS: value_targeted = -1, actual_value = -1, target_date = "", actual_date = "", unit = "", metric = "", signal_id = "".
  - direction: "positive" | "negative" | "neutral" | "watch". NEVER a signal-vocabulary value.

DATE FORMAT — STRICT ISO 8601, LAST DAY OF PERIOD:
Every date field MUST be YYYY-MM-DD. Indian fiscal year ends 31 March: FY2026 → "2026-03-31". FY quarters: Q1 → Jun 30, Q2 → Sep 30, Q3 → Dec 31, Q4 → Mar 31.

SCORE & STATUS DERIVATION (DETERMINISTIC):
1. Assess each of the 5 pattern slots below. Score each present pattern: positive/steady/disciplined = +2; watch = 0; negative/rising-risk/gap-detected = -2. Pattern below threshold (< 2 signals) = 0.
2. Base = 50. Add pattern scores. Clamp to [0, 100].
3. score ≥ 70 → "STRONG"; 40–69 → "MODERATE"; < 40 → "WEAK".
Report in key_metrics: "roce" (latest % or "N/A"), "cfo_capex_coverage" (ratio or "N/A"), "net_debt_ebitda" (ratio or "N/A"), "last_dilution_event" (e.g. "FY22 QIP" or "None on record").

top_signals[] LAYOUT — 4 KPI ACTUALS + META:

  KPI ACTUALS (one row each, from PPT / Prowess / annual report signals only — never transcript):
  • metric: "KPI_ROCE"        — actual_value: latest ROCE %, delta: YoY change, unit: "%", direction: "beat" if improving, "miss" if declining, "tracking" if no trend
  • metric: "KPI_CFO_CAPEX"   — actual_value: CFO/CAPEX coverage ratio, unit: "x", direction: "beat" if ≥1.5x, "in_line" if 1–1.5x, "miss" if <1x
  • metric: "KPI_NET_DEBT_EB" — actual_value: Net Debt/EBITDA ratio, unit: "x", direction: "beat" if declining, "miss" if rising, "in_line" if stable
  • metric: "KPI_DPS"         — actual_value: latest DPS, delta: YoY change, unit: "₹", direction: "beat" if growing, "miss" if cut, "in_line" if stable
  If a KPI is absent from signals: actual_value = -1, statement = "Not in supplied signals", direction = "tracking".

  META SIGNALS (after KPI rows):
  metric: "META_ROCE"         — label: latest ROCE % or "N/A", statement: period + source (≤60 chars), impact: "high"
  metric: "META_CFO_CAPEX"    — label: coverage ratio or "N/A", statement: "CFO vs CAPEX self-funding ratio" (≤60 chars), impact: "high"
  metric: "META_NET_DEBT_EB"  — label: Net Debt/EBITDA or "N/A", statement: period context (≤60 chars), impact: "high"
  metric: "META_LAST_DILUTION"— label: last dilution event or "None on record", statement: brief context (≤60 chars), impact: "medium"
  metric: "META_VERDICT"      — label: 3–5 word capital discipline verdict, statement: one-line rationale (≤80 chars), impact: "high"
  (Omit direction on all META_* signals)

PATTERN ANALYSIS — FIVE CAPITAL ALLOCATION PATTERN TYPES:
Run each pattern only if signals meet its inclusion threshold. Below threshold → direction = "watch", confidence ≤ 0.4, sentence states "Insufficient signals". Patterns not present in the data → direction = "neutral", note absence explicitly in confidence_reason.

Five pattern_type values (use exactly these slugs):
  deployment_discipline       — Capex quantum trend and source of funds. Is growth self-funded or leverage-expanding? (threshold: funding source language in ≥2 periods)
  returns_on_capital          — ROCE/ROIC trajectory. CRITICAL: distinguish legacy capital performing vs. new capital unproven (CWIP). Improving ROCE ≠ new capital earning returns. (threshold: returns metric in ≥2 periods)
  conviction_accountability_gap — Management makes repeated high-conviction statements about a capital program WITHOUT utilization targets, payback, or revenue contribution. Absence of accountability language is itself the signal. (threshold: conviction language in ≥2 periods for same program WITHOUT accountability markers)
  shareholder_return_discipline — Dividend/buyback trajectory and stated rationale. Absence of payout growth despite strong FCF = capital hoarding signal. (threshold: ≥1 dividend or buyback signal)
  ma_allocation_quality       — Inorganic capital: rationale clarity, integration track record, synergy delivery in subsequent periods. (threshold: ≥1 M&A signal with stated rationale)

Conviction language markers (triggers conviction_accountability_gap detection): "we are confident / committed / on track", "decade-long bet", "structural investment", "significant demand", repeated reference to a program without new accountability data.
Accountability language markers (absence triggers Watch): specific utilization % with date, payback period or IRR, revenue contribution timeline, unit economics disclosure.

For shape_data: JSON array of {period, count} when per-quarter mention frequency is derivable (conviction vs. accountability keyword counts); else "".
Confidence (0.0–1.0): 0.8–1.0 clear directional change, 3+ periods; 0.5–0.7 direction clear but thin data; 0.3–0.4 suggestive watch signal.
Aim for patterns that are present — do NOT force all five. An output with 3 strong patterns beats one with 5 weak ones.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with overall capital discipline verdict and key tension.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Conviction gap", "Leverage expanding").
- "label": 2–5 words, title-case.
- "statement": ≤80 chars, verbatim or tightly paraphrased from source signal.
- "sentence" (patterns): one plain-language directional claim leading with the change.
- Never pad with filler phrases.

Return a JSON object conforming EXACTLY to the lens_score schema:
{
  "score": <integer 0-100, per SCORE & STATUS DERIVATION>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, capital discipline verdict + key tension>,
  "key_metrics": { "roce": <string>, "cfo_capex_coverage": <string>, "net_debt_ebitda": <string>, "last_dilution_event": <string> },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [ <KPI_ROCE, KPI_CFO_CAPEX, KPI_NET_DEBT_EB, KPI_DPS; then META_ROCE, META_CFO_CAPEX, META_NET_DEBT_EB, META_LAST_DILUTION, META_VERDICT> ],
  "patterns":    [ <capital allocation pattern children — up to 5; [] if no signals> ]
}

Child object (NO nulls — use sentinels):
  kind, signal_id, metric, label, impact, direction, statement, original_statement, source_ref,
  announcement_date, value_targeted, value_targeted_low, value_targeted_high, target_date,
  actual_value, actual_date, unit, delta, guided_value, guided_date,
  pattern_type, confidence, confidence_reason, sentence, shape_data, shape_label, evidence[]
`,
    },
  },
  {
    slug:         'disclosure-honesty',
    name:         'Disclosure Honesty',
    category:     'management',
    description:  'Transparency and candour of management disclosures — proactive vs defensive communication',
    force_config: true,
    version:      '2.0.0',
    config: {
      signal_filters: {
        // kpi: Prowess financial actuals — grounds narrative signals against real reported numbers (tone vs. numbers divergence)
        // disclosure_quality: voluntary vs statutory disclosure events, topic deflections, proactive risk surfacing
        // governance_signal: audit committee, auditor appointments, RPT disclosures, SEBI compliance, KAMs
        // earnings_quality: exceptional/one-off item framing, auditor key audit matters — independent governance signal
        // risk_factor: disclosed business risks with mitigation — reveals candour about downside
        // contingent_liability: legal/tax disputes — whether surfaced proactively or buried in notes
        // mgmt_tone: sentiment per quarter — feeds tone-disclosure divergence detection
        // analyst_questions: what analysts had to pry out — confirms voluntary disclosure gaps
        signal_types:      ['kpi', 'disclosure_quality', 'governance_signal', 'earnings_quality', 'risk_factor', 'contingent_liability', 'mgmt_tone', 'analyst_questions'],
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings call transcripts, investor PPTs, and annual reports using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured disclosure-honesty view conforming EXACTLY to the lens_score JSON schema.

PROVENANCE GATE — NON-NEGOTIABLE:
- Do NOT invent data. Work only from the signals provided.
- Every quote, absence claim, and governance fact must trace verbatim to a supplied signal. If not in the input, it does not exist — use -1 / "" sentinels.
- A pattern requires ≥2 distinct signals. A pattern supported by only 1 signal → direction = "watch", confidence ≤ 0.4.
- No signals supplied → do not generate analysis. Set score = 50, status = "MODERATE", takeaway = "Insufficient disclosure signals to score."

ABSENCE CLAIM GATE — HIGHEST HALLUCINATION RISK:
Before marking any topic as absent ("Doesn't Say"), BOTH conditions must be met:
  (1) Materiality confirmed: signals exist showing the topic is relevant to investors OR analyst questions on the topic appear in the input.
  (2) No disclosure signal exists in the supplied input for that topic.
If either condition is unmet → absence claim is [NULL]. Do not claim absence because a signal "seems like it should exist."

{{DATA_BLOCK}}

=== SHARED CHILD SCHEMA — FIELD BANDS ===
Both "top_signals" and "patterns" use the SAME child object. No nullable fields — use sentinels: "" for strings, -1 for numbers, [] for evidence arrays.
- Every item in "top_signals" MUST have kind = "signal".
- Every item in "patterns" MUST have kind = "pattern".

kind = "signal" (disclosure indicator and meta entries):
  - MUST be meaningful: kind, label, impact, direction, statement.
  - actual_value: numeric indicator or -1. actual_date: YYYY-MM-DD last day of period or "".
  - Pattern band SENTINELS: pattern_type = "none", confidence = -1, confidence_reason = "", sentence = "", shape_data = "", shape_label = "", evidence = [].
  - direction: "beat" | "miss" | "in_line" | "tracking". NEVER a pattern-vocabulary value.

kind = "pattern" (disclosure behaviour patterns):
  - MUST be meaningful: kind, label, impact, direction, pattern_type, confidence, confidence_reason, sentence.
  - evidence MUST have ≥1 item with verbatim quote, signal_id, ISO period. evidence.value = -1 when no numeric count.
  - shape_data: JSON array of {period, count} for sparkline when per-quarter disclosure depth/frequency is derivable; else "".
  - Signal band SENTINELS: value_targeted = -1, actual_value = -1, target_date = "", actual_date = "", unit = "", metric = "", signal_id = "".
  - direction: "positive" | "negative" | "neutral" | "watch". NEVER a signal-vocabulary value.

DATE FORMAT — STRICT ISO 8601, LAST DAY OF PERIOD:
Every date field MUST be YYYY-MM-DD. Indian fiscal year ends 31 March: FY2026 → "2026-03-31". FY quarters: Q1 → Jun 30, Q2 → Sep 30, Q3 → Dec 31, Q4 → Mar 31.

SCORE & STATUS DERIVATION (DETERMINISTIC):
1. Assess each of the 5 pattern slots below. Score each present pattern: positive/expanding/consistent/resolving = +2; neutral/steady = 0; watch/reactive/unresolved = -1; negative/gap/escalating/silent = -2. Pattern below threshold = 0.
2. Base = 50. Add pattern scores. Clamp to [0, 100].
3. score ≥ 70 → "STRONG"; 40–69 → "MODERATE"; < 40 → "WEAK".
Report in key_metrics: "disclosure_posture" (e.g. "proactive" | "reactive" | "statutory-only"), "kam_status" (e.g. "Stable — 2 KAMs" or "N/A — no annual report signals"), "voluntary_ratio" (e.g. "High" | "Moderate" | "Low" | "N/A").

top_signals[] LAYOUT — DISCLOSURE INDICATORS + META:

  DISCLOSURE INDICATORS (one row each — populate from signals; use -1 / "" if absent):
  • metric: "IND_VOLUNTARY_DEPTH"  — actual_value: count of voluntary disclosure signals (unprompted) in input, unit: "signals", direction: "beat" if growing vs prior period, "miss" if contracting, "tracking" if stable/unknown
  • metric: "IND_DEFLECTIONS"      — actual_value: count of analyst question deflections in input, unit: "deflections", direction: "miss" if any present, "beat" if zero, "tracking" if unclear
  • metric: "IND_KAM_COUNT"        — actual_value: number of Key Audit Matters in latest annual report, unit: "KAMs", direction: "beat" if decreasing, "miss" if increasing, "in_line" if stable. Set to -1 if no annual report signals.
  • metric: "IND_RECURRING_ONEOFF" — actual_value: count of items labelled one-off appearing in ≥2 periods, unit: "items", direction: "miss" if any present, "beat" if zero, "tracking" if unclear

  META SIGNALS (after indicator rows):
  metric: "META_POSTURE"        — label: 3–5 word disclosure posture, e.g. "Proactive, granular, consistent", statement: one-line basis (≤60 chars), impact: "high"
  metric: "META_KAM_STATUS"     — label: KAM summary e.g. "2 KAMs — stable" or "N/A", statement: "Key audit matters from latest annual report" (≤60 chars), impact: "high"
  metric: "META_VOLUNTARY_RATIO"— label: "High" | "Moderate" | "Low" | "N/A", statement: "Voluntary vs statutory disclosure ratio" (≤60 chars), impact: "high"
  metric: "META_VERDICT"        — label: 3–5 word disclosure verdict, e.g. "Reactive on bad news", statement: one-line rationale (≤80 chars), impact: "high"
  (Omit direction on all META_* signals)

PATTERN ANALYSIS — FIVE DISCLOSURE BEHAVIOUR PATTERN TYPES:
Run each pattern only if signals meet its inclusion threshold. Below threshold → direction = "watch", confidence ≤ 0.4, sentence states "Insufficient signals". Patterns structurally absent from the input → direction = "neutral", note absence in confidence_reason.

Five pattern_type values (use exactly these slugs):
  voluntary_statutory_ratio  — Is information surfaced by management choice or regulatory requirement? Is the ratio changing as business complexity grows? Analyst deflections directly reduce this ratio. (threshold: observable voluntary vs statutory difference across ≥2 periods or sources)
  granularity_by_segment     — Is disclosure depth consistent across all material segments? Systematic thinness on high-growth / unproven segments is a watch signal — but only flag when (a) the segment is financially material OR (b) analysts are being deflected on it. (threshold: ≥2 segments with measurably different disclosure depth)
  exceptional_item_framing   — Are one-offs flagged proactively in opening remarks or buried in Q&A? Do "exceptional" items recur? (threshold: ≥1 exceptional/one-off item in input). If none → [NULL] — do not infer from sector.
  bad_news_acknowledgement   — When metrics deteriorate or timelines slip, does management surface it before or after numbers move? Reactive acknowledgement (numbers move first) = watch. Silent absorption (narrative unchanged) = gap. (threshold: ≥1 instance of metric deterioration AND management commentary on it in input)
  audit_matter_evolution     — KAMs flagged by external auditors: new, recurring, or resolving? Convergence of KAM topics with management vagueness on same topics = escalated concern. Source: annual report signals ONLY — never inferred from call transcripts. (threshold: annual report signal present with auditor disclosures. If absent → [NULL])

SAYS CLEARLY / VAGUELY / DOESN'T SAY — populate via patterns[]:
Use three additional pattern entries with these exact pattern_type slugs to encode the analysis structure:
  says_clearly  — Topics disclosed granularly, consistently, voluntarily. direction = "positive". Each evidence item: verbatim quote + signal_id. Only include topics disclosed beyond statutory minimum.
  says_vaguely  — Topics present in signals but without specificity to independently verify. direction = "watch". Each evidence item: what is said vs what is missing. Only include if topic is material AND disclosure is confirmed thin.
  doesnt_say    — Material topics with no disclosure signal. direction = "negative". ABSENCE CLAIM GATE APPLIES: both materiality and signal-absence must be verified for each item. evidence.value = -1. If gate fails → omit the item entirely.

For shape_data in detection patterns: JSON array of {period, count} when per-quarter disclosure depth or deflection frequency is derivable; else "".
Confidence (0.0–1.0): 0.8–1.0 clear multi-period pattern, verbatim evidence; 0.5–0.7 direction clear but thin; 0.3–0.4 suggestive watch signal.
Aim for patterns that are present — do NOT force all five. 2 strong patterns beat 5 weak ones.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with disclosure posture (proactive / reactive / defensive / statutory-only).
- "highlights": up to 3 items, max 12 words each, start with a verb or topic.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Absence claim", "Recurring one-offs").
- "label": 2–5 words, title-case.
- "statement": ≤80 chars, verbatim or tightly paraphrased from source signal.
- "sentence" (patterns): one plain-language directional claim — what changed and what it means.
- Never pad with filler phrases.

Return a JSON object conforming EXACTLY to the lens_score schema:
{
  "score": <integer 0-100, per SCORE & STATUS DERIVATION>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, disclosure posture + key finding>,
  "key_metrics": { "disclosure_posture": <string>, "kam_status": <string>, "voluntary_ratio": <string> },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [ <IND_VOLUNTARY_DEPTH, IND_DEFLECTIONS, IND_KAM_COUNT, IND_RECURRING_ONEOFF; then META_POSTURE, META_KAM_STATUS, META_VOLUNTARY_RATIO, META_VERDICT> ],
  "patterns":    [ <5 detection patterns + says_clearly + says_vaguely + doesnt_say; [] if no signals> ]
}

Child object (NO nulls — use sentinels):
  kind, signal_id, metric, label, impact, direction, statement, original_statement, source_ref,
  announcement_date, value_targeted, value_targeted_low, value_targeted_high, target_date,
  actual_value, actual_date, unit, delta, guided_value, guided_date,
  pattern_type, confidence, confidence_reason, sentence, shape_data, shape_label, evidence[]
`,
    },
  },
  {
    slug:         'promoter-activity',
    name:         'Promoter Activity',
    category:     'management',
    description:  'Promoter shareholding trends, pledging, and insider confidence signals',
    force_config: true,
    version:      '2.0.1',
    config: {
      signal_filters: {
        // kpi: Prowess financial actuals — shareholding-derived metrics, ROCE, debt ratios that ground the ownership narrative
        // governance_signal: shareholding filings, pledge disclosures, insider transactions, SEBI compliance
        // milestone: ESOP/RSU issuance, equity capital changes from annual reports
        // financial_figure: shareholding category breakdowns (promoter, FII, DII, ADR) from annual reports/PPTs
        // capital_allocation: buyback announcements, QIP/rights/OFS events, ESOP programme updates
        // m_and_a: OFS / block deals, subsidiary IPO events, stake changes
        // mgmt_tone: management language on capital return, buyback rationale, shareholding commentary
        // analyst_questions: analyst pressure on pledge, stake sale, subsidiary IPO — deflection is a signal
        signal_types:      ['kpi', 'governance_signal', 'milestone', 'financial_figure', 'capital_allocation', 'm_and_a', 'mgmt_tone', 'analyst_questions'],
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
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings call transcripts, investor PPTs, and annual reports using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured promoter-activity view conforming EXACTLY to the lens_score JSON schema.

PROVENANCE GATE — NON-NEGOTIABLE:
- Do NOT invent data. Work only from the signals provided.
- Every ownership figure (stake %, pledge %, ESOP quantum, institutional %) must be verbatim from a supplied signal. If not in the input, it does not exist — use -1 / "" sentinels.
- A pattern requires ≥2 distinct signals. A pattern supported by only 1 signal → direction = "watch", confidence ≤ 0.4.
- No signals supplied → do not generate analysis. Set score = 50, status = "MODERATE", takeaway = "Insufficient ownership signals to score."

OWNERSHIP STRUCTURE DETERMINATION — DO THIS FIRST:
Before any pattern or timeline entry, determine the ownership type from the signals:
  - "promoter-controlled" — promoter category % present in filings
  - "promoter-free" — confirmed no promoter entity (e.g. professionally managed post-merger)
  - "government-owned" — government as promoter
  - "transition" — ownership structure changing during the supplied period
State this in key_metrics.ownership_type. This determination gates which patterns are applicable:
  - promoter-free → Pledge Risk pattern is structurally NULL (state it, do not silently omit)
  - promoter-free → no promoter buying/selling signal applies

{{DATA_BLOCK}}

=== SHARED CHILD SCHEMA — FIELD BANDS ===
Both "top_signals" and "patterns" use the SAME child object. No nullable fields — use sentinels: "" for strings, -1 for numbers, [] for evidence arrays.
- Every item in "top_signals" MUST have kind = "signal".
- Every item in "patterns" MUST have kind = "pattern".

kind = "signal" (timeline and meta entries):
  - MUST be meaningful: kind, label, impact, direction, statement.
  - actual_value: numeric ownership figure or -1 if absent. actual_date: YYYY-MM-DD last day of period or "".
  - guided_value: pledge % for PROMOTER_STAKE rows, -1 elsewhere. guided_date: same period end or "".
  - delta: signed change vs prior period or -1. unit: "%" or "".
  - Pattern band SENTINELS: pattern_type = "none", confidence = -1, confidence_reason = "", sentence = "", shape_data = "", shape_label = "", evidence = [].
  - direction: "beat" | "miss" | "in_line" | "tracking". NEVER a pattern-vocabulary value.

kind = "pattern" (ownership behaviour patterns):
  - MUST be meaningful: kind, label, impact, direction, pattern_type, confidence, confidence_reason, sentence.
  - evidence MUST have ≥1 item with verbatim quote, signal_id, ISO period. evidence.value = -1 when no numeric count.
  - shape_data: JSON array of {period, count} for sparkline when countable (e.g. analyst question frequency); else "".
  - Signal band SENTINELS: value_targeted = -1, actual_value = -1, target_date = "", actual_date = "", unit = "", metric = "", signal_id = "".
  - direction: "positive" | "negative" | "neutral" | "watch". NEVER a signal-vocabulary value.

DATE FORMAT — STRICT ISO 8601, LAST DAY OF PERIOD:
Every date field MUST be YYYY-MM-DD. Indian fiscal year ends 31 March: FY2026 → "2026-03-31". FY quarters: Q1 → Jun 30, Q2 → Sep 30, Q3 → Dec 31, Q4 → Mar 31.

SCORE & STATUS DERIVATION (DETERMINISTIC):
1. Assess each of the 6 pattern slots below. Score each present pattern: Stable/Clean/High-quality/Disciplined/Disclosed = +2; Watch = 0; Negative/Rising risk/Dilutive/Deflected = -2. Structurally NULL = 0.
2. Base = 50. Add pattern scores. Clamp to [0, 100].
3. score ≥ 70 → "STRONG"; 40–69 → "MODERATE"; < 40 → "WEAK".
Report in key_metrics: "ownership_type", "current_stake" (latest % or "N/A"), "pledge_pct" (latest % or "None"), "last_dilution_event" (e.g. "FY22 QIP" or "None on record").

top_signals[] LAYOUT — emit in this exact order:

  SECTION 1 — PROMOTER_STAKE rows (one per quarter/period, chronologically oldest first):
  • metric: "PROMOTER_STAKE"
  • label: period label e.g. "Mar 2026", "Dec 2024" (max 12 chars)
  • statement: signal narrative — stake level, event, or stability note (≤80 chars, verbatim where possible)
  • actual_value: promoter stake % as a number, or -1 if absent
  • guided_value: pledge % as a number, or -1 if no pledge data
  • delta: QoQ change in stake (signed %, e.g. -0.5), or -1 if first period / unknown
  • delta_pct: QoQ % change relative to prior stake (e.g. -0.8 means stake fell 0.8%), or -1 if unknown
  • unit: "%"
  • direction: "beat" if stake rose or pledge fell, "miss" if stake fell or pledge rose, "in_line" if stable, "tracking" if inferred from narrative only
  • actual_date: YYYY-MM-DD last day of the period (e.g. "2026-03-31" for Mar 2026)
  • guided_date: same as actual_date
  • impact: "high" | "medium" | "low"
  If promoter-free: emit one PROMOTER_STAKE row with actual_value = -1, guided_value = -1, delta = -1, delta_pct = -1, statement = "No promoter entity — institutionally owned", direction = "in_line".

  SECTION 2 — PROMOTER_INSIGHT cards (exactly 3, after all PROMOTER_STAKE rows):
  These are the three structural insight cards: Stability, Pending Event, Insider Signal.
  • metric: "PROMOTER_INSIGHT"
  • label: card title — 3–6 words (e.g. "Stake stable, no dilution", "Subsidiary IPO pending", "No insider selling detected")
  • statement: 1–2 sentences — insight body and investment relevance (≤80 chars)
  • direction: "beat" (green) | "tracking" (amber) | "miss" (red)
  • impact: "high" | "medium" | "low"
  Emit in this order: [0] Stability insight, [1] Pending Event insight (if none: direction = "in_line", label = "No pending ownership event"), [2] Insider Signal insight.

  SECTION 3 — META SIGNALS (after the 3 PROMOTER_INSIGHT entries):
  metric: "META_CURRENT_STAKE" — label: latest stake % or "N/A", statement: period + source (≤60 chars), impact: "high"
  metric: "META_PLEDGE_PCT"    — label: pledge % or "None" or "N/A", statement: "Pledge as % of promoter shares" (≤60 chars), impact: "high"
  metric: "META_LAST_DILUTION" — label: last dilution event or "None on record", statement: brief context (≤60 chars), impact: "medium"
  metric: "META_INSIDER_NOTE"  — label: 5–8 word insider sentiment read, statement: basis (≤60 chars), impact: "medium"
  metric: "META_VERDICT"       — label: 3–5 word ownership verdict, statement: one-line rationale (≤80 chars), impact: "high"
  (Omit direction on all META_* signals)

PATTERN ANALYSIS — SIX OWNERSHIP PATTERN TYPES:
Run each pattern only if signals meet its inclusion threshold. A pattern type with insufficient signals → direction = "watch", confidence ≤ 0.4, sentence states "Insufficient signals". If structurally inapplicable (e.g. Pledge Risk for a promoter-free company), state it explicitly in confidence_reason and set direction = "neutral".

Six pattern_type values (use exactly these slugs):
  ownership_structure   — Is there a promoter? Family/institutional/govt? Any structural change? (threshold: any shareholding signal from annual report or PPT)
  pledge_risk           — Pledge level and direction. (threshold: promoter entity confirmed. NULL if promoter-free — state this)
  insider_participation — ESOP/RSU issuance or buyback programme. (threshold: ≥1 ESOP/buyback signal)
  equity_discipline     — Dilutive equity raises (QIP, rights, OFS) vs preservation. (threshold: any equity capital change signal)
  institutional_quality — FII/DII composition, sovereign/pension holder presence. (threshold: institutional breakdown in annual report)
  pending_ownership_event — Subsidiary IPO, promoter stake sale, merger/demerger pending. (threshold: any pending ownership change signal or analyst deflection)

For each pattern: shape_data = JSON array of {period, count} when per-quarter trend is derivable, else "".
Confidence (0.0–1.0): 0.8–1.0 clear directional change, 3+ periods; 0.5–0.7 direction clear but thin data; 0.3–0.4 suggestive watch signal.
Aim for patterns that are present — do NOT force all six. An output with 3 strong patterns beats one with 6 weak ones.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with ownership structure type and key signal.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Pledge risk", "Dilution overhang").
- "label": 2–5 words, title-case.
- "statement": ≤80 chars, verbatim or tightly paraphrased from source signal.
- "sentence" (patterns): one plain-language directional claim leading with the change.
- Never pad with filler phrases.

Return a JSON object conforming EXACTLY to the lens_score schema:
{
  "score": <integer 0-100, per SCORE & STATUS DERIVATION>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, ownership structure type + key signal>,
  "key_metrics": { "ownership_type": <string>, "current_stake": <string>, "pledge_pct": <string>, "last_dilution_event": <string> },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [ <PROMOTER_STAKE rows oldest→newest; then 3 PROMOTER_INSIGHT rows; then META_CURRENT_STAKE, META_PLEDGE_PCT, META_LAST_DILUTION, META_INSIDER_NOTE, META_VERDICT> ],
  "patterns":    [ <ownership pattern children — up to 6; [] if no signals> ]
}

Child object (NO nulls — use sentinels):
  kind, signal_id, metric, label, impact, direction, statement, original_statement, source_ref,
  announcement_date, value_targeted, value_targeted_low, value_targeted_high, target_date,
  actual_value, actual_date, unit, delta, delta_pct, guided_value, guided_date,
  pattern_type, confidence, confidence_reason, sentence, shape_data, shape_label, evidence[]
`,
    },
  },
  // ── Opportunity lenses ───────────────────────────────────────────────────────
  {
    slug:        'industry-analysis',
    name:        'Industry Analysis',
    category:    'opportunity',
    description: 'Demand/supply dynamics and structural positioning within the industry',
    force_config: true,
    version:     '1.2.0',
    config: {
      signal_filters: {
        // industry_signal: TAM, sector CAGR, demand/supply environment, macro tailwinds from all peers
        // kpi: peer financial KPIs for industry aggregate benchmarking
        // growth_forecast: stated sector/company growth rates and projections
        // competitive_position: market share and structural positioning signals from peers
        signal_types:  ['industry_signal', 'kpi', 'growth_forecast', 'competitive_position'],
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
    version:     '1.2.0',
    config: {
      signal_filters: {
        // competitive_position: moat claims, market share, peer comparison statements
        // pricing_power: pass-through ability, realization trends, contract structure
        // industry_signal: structural demand/supply that defines competitive intensity
        // kpi: financial actuals to measure outperformance vs peers (margins, ROCE)
        // strategic_claim: management's positioning claims that can be stress-tested vs peers
        signal_types:  ['competitive_position', 'pricing_power', 'industry_signal', 'kpi', 'strategic_claim'],
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
    version:     '1.6.0',
    config: {
      signal_filters: {
        // kpi: primary source — EBITDA, PAT, CFO, ROCE, NIM, GNPA, DE, all balance sheet metrics
        // financial_figure: reported annual report line items not captured as KPIs (dividends, capex schedules)
        // earnings_quality: exceptional items, working capital anomalies that distort reported strength
        // contingent_liability: off-balance-sheet exposures that affect true financial strength
        // growth_forecast: revenue/earnings trajectory signals management provides
        signal_types:  ['kpi', 'financial_figure', 'earnings_quality', 'contingent_liability', 'growth_forecast'],
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
    version:     '1.3.0',
    config: {
      signal_filters: {
        // distribution_customer: segment revenue mix, customer base, channel reach, retention signals
        // kpi: customer count KPIs, AUM, order book, revenue per customer metrics
        // milestone: achieved distribution milestones (outlet count, subscriber additions)
        // guidance: management targets for customer/channel growth
        // growth_forecast: stated revenue growth rates by segment
        signal_types:       ['distribution_customer', 'kpi', 'milestone', 'guidance', 'growth_forecast'],
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
    version:      '1.6.0',
    config: {
      signal_filters: {
        // kpi: historical P&L actuals — the base for all scenario projections
        // financial_figure: reported annual report financials to anchor multi-year trend
        // guidance: management's own forward revenue/margin targets inform base case
        // growth_forecast: stated growth rates and trajectory signals
        // industry_signal: sector growth CAGR anchors the bull/base/bear industry row
        // earnings_quality: exceptional items that inflate/deflate the earnings base
        // capital_allocation: capex plans that affect future depreciation and FCF
        signal_types:       ['kpi', 'financial_figure', 'guidance', 'growth_forecast', 'industry_signal', 'earnings_quality', 'capital_allocation'],
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
    version:      '1.5.0',
    config: {
      signal_filters: {
        // kpi: EPS, PAT, CFO, EBITDA, ROCE — the core earnings quality metrics over time
        // financial_figure: annual report P&L line items for multi-year trend reconstruction
        // earnings_quality: exceptional items, working capital distortions, cash conversion signals
        // growth_forecast: management's own view on earnings trajectory
        signal_types:       ['kpi', 'financial_figure', 'earnings_quality', 'growth_forecast'],
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
    version:      '1.6.0',
    config: {
      signal_filters: {
        // kpi: ROE, ROCE, PAT, EBITDA_MARGIN — the fundamental drivers of multiple expansion
        // guidance: management's forward targets — credible guidance raises the re-rating case
        // guidance_revision: upgrades signal positive re-rating; downgrades signal de-rating risk
        // milestone: delivered commitments validate management credibility → multiple expansion
        // disclosure_quality: governance quality is a re-rating catalyst (auditor flags = de-rating risk)
        // industry_signal: sector tailwinds that justify a higher multiple
        // strategic_claim: positioning claims management uses to argue for a premium multiple
        signal_types:       ['kpi', 'guidance', 'guidance_revision', 'milestone', 'disclosure_quality', 'industry_signal', 'strategic_claim'],
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
    version:      '1.3.0',
    config: {
      signal_filters: {
        // kpi: EPS, PAT, EBITDA_MARGIN — the inputs to Future EPS × Exit P/E calculation
        // financial_figure: annual report financials for multi-year EPS base reconstruction
        // guidance: management's own forward PAT/EPS targets anchor the base-case scenario
        // guidance_revision: upgrades/downgrades shift scenario probabilities
        // growth_forecast: revenue and PAT growth rates for the 3Y CAGR waterfall
        // earnings_quality: exceptional items that inflate the EPS base (must be stripped)
        // milestone: delivered past targets establish management's track record for scenario weighting
        signal_types:       ['kpi', 'financial_figure', 'guidance', 'guidance_revision', 'growth_forecast', 'earnings_quality', 'milestone'],
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
