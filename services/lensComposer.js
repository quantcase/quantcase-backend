'use strict';

const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { sortLensesByConfig } = require('../lib/insightLenses');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { lensOutputSchema } = require('../outputSchemas/lens');
const { computeSourceHash } = require('../utils/sourceHash');
const { fetchPeerMetrics, formatPeerMetricsBlock, fetchEquityMetrics, formatEquityMetricsBlock } = require('./peerMetrics');
const prowess = require('../lib/prowess');
const { JSON_OUTPUT_CONTRACT } = require('../prompts/jsonOutputContract');

const PEER_LENS_SLUGS = new Set(['competition', 'industry-analysis']);

// ─── Shareholding block for promoter-activity lens ───────────────────────────

// Quarter label from CSV (e.g. "Jun 2024") → fiscal quarter notation (e.g. "FY25 Q1")
const MONTH_TO_FY_QUARTER = {
  'Jun': { quarter: 'Q1', fyOffset: 1 },
  'Sep': { quarter: 'Q2', fyOffset: 1 },
  'Dec': { quarter: 'Q3', fyOffset: 1 },
  'Mar': { quarter: 'Q4', fyOffset: 0 },
};

function quarterLabelToFiscal(label) {
  // label = "Jun 2024", "Mar 2025", etc.
  const [mon, yearStr] = label.split(' ');
  const calYear = parseInt(yearStr, 10);
  const map = MONTH_TO_FY_QUARTER[mon];
  if (!map || !calYear) return label;
  const fy = (calYear + map.fyOffset).toString().slice(-2);
  return `FY${fy} ${map.quarter}`;
}

// Quarter label → ISO date of last day of that period
function quarterLabelToDate(label) {
  const [mon, yearStr] = label.split(' ');
  const calYear = parseInt(yearStr, 10);
  const lastDay = { Jun: '06-30', Sep: '09-30', Dec: '12-31', Mar: '03-31' };
  return lastDay[mon] ? `${calYear}-${lastDay[mon]}` : null;
}

function buildShareholdingBlock(ticker) {
  const identityMap = prowess.loadIdentityMap();
  const companyName = identityMap[ticker?.toUpperCase()];
  if (!companyName) return '';

  const { quarterLabels, companyMap } = prowess.loadShareholdingData();
  const row = companyMap[companyName];
  if (!row) return '';

  const lines = ['\nSHAREHOLDING PATTERN (from Prowess filings):'];
  lines.push('Period       | Promoter%  | Pledge%  | QoQ Δ    | Date');
  lines.push('-------------|------------|----------|----------|------------');

  let prevPromoters = null;
  let hasAnyData = false;

  for (let i = 0; i < prowess.SH_PERIOD_COUNT; i++) {
    const label = quarterLabels[i];
    const d = prowess.shPeriodData(row, i);
    if (d.promoters == null) continue;

    hasAnyData = true;
    const fiscal  = quarterLabelToFiscal(label);
    const date    = quarterLabelToDate(label) ?? '';
    const delta   = prevPromoters != null ? prowess.r2(d.promoters - prevPromoters) : null;
    const deltaStr = delta != null ? (delta >= 0 ? `+${delta}%` : `${delta}%`) : 'first';
    const pledgeStr = d.custodians != null ? `${d.custodians}%` : 'N/A';
    lines.push(`${fiscal.padEnd(12)} | ${String(d.promoters + '%').padEnd(10)} | ${pledgeStr.padEnd(8)} | ${deltaStr.padEnd(8)} | ${date}`);
    prevPromoters = d.promoters;
  }

  if (!hasAnyData) return '';

  lines.push('');
  lines.push(`Note: "Pledge%" = custodians column from Prowess (shares in demat/pledge). Δ = change vs prior quarter.`);

  return lines.join('\n');
}

// ─── L2 default prompt template ─────────────────────────────────────────────
// {{LENS_INSTRUCTIONS}} is injected from LensConfig.config.prompt_template (per-lens guidelines).
// Leave prompt_template null to omit the section entirely.

const L2_DEFAULT_PROMPT = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings call transcripts (guidance and narrative), investor PPTs, the Prowess financial API, and annual reports using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view that conforms EXACTLY to the lens_score JSON schema (defined in lens.js). That schema is the contract. This prompt tells you how to fill it. Guidance_l2_v5_refined.md is the analytical methodology behind these rules; where it differs from this prompt on output shape, enums, or date format, THIS PROMPT WINS.

PROVENANCE GATE — NON-NEGOTIABLE:
- Do NOT invent data. Work only from the signals provided.
- Do NOT paraphrase. Every quoted field must be the exact verbatim text from the Data Block.
- Do NOT backfill. Never use an actual value to infer a guided value that was not explicitly stated.
- If a guided value, target date, or actual value cannot be traced to a supplied signal, use the sentinel (-1 for numbers, "" for strings). Never substitute an already-achieved number for a missing target.

SOURCE OF TRUTH — STRICT:
- Guidance commitments (value_targeted / value_targeted_low / value_targeted_high / target_date) come ONLY from earnings call transcripts, and only from signals of type "guidance_timebound" or signals of type "ongoing" with category "timebound".
- Actual values (actual_value / actual_date) come ONLY from investor PPTs or the Prowess financial API. Never derive an actual from a transcript, an annual report, or a calculation.
- All other signal types and sources provide narrative context for pattern analysis only — they never populate the guidance commitment fields or the actual fields.
{{LENS_INSTRUCTIONS}}
{{DATA_BLOCK}}

=== SHARED CHILD SCHEMA — FIELD BANDS (READ CAREFULLY) ===
Both "top_signals" and "patterns" are arrays of the SAME child object. The schema has NO nullable fields — every field is required and typed. Express "not applicable" using sentinels: "" for strings, -1 for numbers, [] for the evidence array. You decide which fields are meaningful using the "kind" discriminator:

- Every item in "top_signals" MUST have kind = "signal".
- Every item in "patterns" MUST have kind = "pattern".

FIELD BANDS — sentinel values by kind:

A) kind = "signal" (guidance track record child):
   - MUST be meaningful: kind, label, impact, direction, original_statement.
   - Guidance band — populate when a forward-looking commitment exists (see tense gate): value_targeted OR (value_targeted_low + value_targeted_high), target_date, announcement_date, unit. If no commitment exists, set all guidance-band numbers to -1 and strings to "" and set direction = "none".
   - Actuals — actual_value, actual_date populated only from PPT/Prowess when available; else actual_value = -1, actual_date = "".
   - source_ref: the page/timestamp/slide/API anchor if available, else "".
   - PATTERN BAND SENTINELS: pattern_type = "none", confidence = -1, confidence_reason = "", sentence = "", shape_data = "", shape_label = "", evidence = [].
   - direction MUST be one of: "beat" | "miss" | "in_line" | "unresolvable" | "none". NEVER use a pattern-vocabulary value here.

B) kind = "pattern" (behavioral pattern child):
   - MUST be meaningful: kind, label, impact, direction, pattern_type, confidence, confidence_reason, sentence.
   - evidence MUST contain at least one item with a verbatim quote, signal_id, and ISO period. evidence.value = -1 when no numeric value applies.
   - shape_data / shape_label: populate where the pattern has a renderable shape; else "".
   - GUIDANCE BAND SENTINELS: value_targeted = -1, value_targeted_low = -1, value_targeted_high = -1, actual_value = -1, target_date = "", actual_date = "", announcement_date = "", unit = "". signal_id = "" and metric = "" when no single source signal/metric.
   - direction MUST be one of: "positive" | "negative" | "neutral" | "watch". NEVER use a signal-vocabulary value here.

This banding is enforced by you, not by the schema. The schema will accept a wrong-band value; the analysis will be wrong. Follow the bands exactly.

FORWARD-LOOKING vs. PAST-ACHIEVEMENT GATE:
Before populating value_targeted/target_date for any signal, classify the source statement by tense:
- FORWARD-LOOKING (a commitment): contains future-intent language — "we guide", "we expect", "we target", "targeting", "outlook", "anticipate", "project", "forecast" — AND a numeric value. Only these populate value_targeted (or value_targeted_low/high for a range) + target_date.
- PAST ACHIEVEMENT (an actual): contains past-tense language — "we delivered", "we achieved", "grew", "posted", "reported", "stood at", "came in at". These are NEVER a target. Actuals are sourced only from PPT/Prowess (see Source of Truth) — a past-tense transcript line is not itself an actual.
- If a statement has no numeric value, or no resolvable target date, set value_targeted = -1 and target_date = "". Do not infer a target from an achieved figure.

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 30 words, action-oriented, lead with the key finding (e.g. "Margins expanding on operating leverage; FCF conversion risk remains — watch CFO/PAT ratio.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "EBITDA margin up 180 bps YoY on cost discipline.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Debt elevated; interest cover below 3x for 2 quarters.")
- "label": 2–5 words, title-case, human-readable (e.g. "Operating Cash Flow")
- "statement": <=80 chars, VERBATIM excerpt from the source — never paraphrased.
- "sentence" (patterns): one line, plain-language causal claim leading with the change.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

DATE FORMAT — STRICT ISO 8601, LAST DAY OF PERIOD (NON-NEGOTIABLE):
Every date field (announcement_date, target_date, actual_date, and evidence.period when it denotes a period) MUST be ISO 8601 (YYYY-MM-DD), resolved to the LAST DAY of the implied period. Never emit free-text period labels like "FY25_END", "FY2026 Q3", or "Q3_FY26".
- Indian fiscal year ends 31 March. FY2026 -> "2026-03-31". FY2025 -> "2025-03-31".
- FY quarters: Q1 -> 30 Jun, Q2 -> 30 Sep, Q3 -> 31 Dec, Q4 -> 31 Mar of the FY-ending calendar year.
  e.g. FY2026 Q3 -> "2025-12-31"; FY2026 Q1 -> "2025-06-30"; FY2025 Q4 -> "2025-03-31".
Period matching (below) is a string-equal comparison on these ISO dates. A free-text label silently breaks matching and forces everything to "unresolvable".

HIT STATUS — PURE COMPARISON, NO DELTA MATH (kind="signal" only):
Never compute deltas, percentage changes, or basis-point differences. Resolve "direction" by comparison only:
- If NO guidance commitment exists on the signal (value_targeted = -1 and both range bounds = -1) → direction = "none".
- Else if value_targeted = -1 (and both range bounds = -1), OR actual_value = -1, OR target_date and actual_date fall in different periods → direction = "unresolvable".
- If a guided range is present (value_targeted_low and value_targeted_high are not -1):
  - actual_value within [low, high] inclusive → "in_line"
  - actual_value > high → "beat"
  - actual_value < low → "miss"
- If value_targeted is a single point (not -1):
  - actual_value > value_targeted → "beat"
  - actual_value < value_targeted → "miss"
  - actual_value == value_targeted → "in_line"

"none" vs "unresolvable" — the boundary:
- "none" = there was never a guidance commitment to track on this row (narrative/context signal). Excluded from the hit-rate denominator.
- "unresolvable" = a commitment exists, but it cannot be scored yet (actual missing, not yet due, or period mismatch). Also excluded from the hit-rate denominator, but it IS a tracked open commitment.

PERIOD MATCHING: only resolve direction (beat/miss/in_line) when target_date and actual_date fall in the same period (string-equal ISO dates). If guidance targets FY26 ("2026-03-31") but the only actual available is FY25 ("2025-03-31"), direction = "unresolvable" — never compare across mismatched periods.

SCORE & STATUS DERIVATION (DETERMINISTIC — DO NOT IMPROVISE):
Compute these in order:
1. Let RESOLVED = count of top_signals with direction in {beat, in_line, miss}.
2. Let HITS = count with direction in {beat, in_line}.
3. If RESOLVED == 0 → score = 50, status = "MODERATE", and takeaway must state "Insufficient resolvable guidance to score." Stop scoring here.
4. hit_rate = HITS / RESOLVED (0.0–1.0).
5. base = round(hit_rate * 100).
6. Coverage adjustment: if RESOLVED < 3, cap score at 60 (low evidence base). Apply: score = min(base, 60) when RESOLVED < 3, else score = base.
7. status from final score: score >= 70 → "STRONG"; 40 <= score <= 69 → "MODERATE"; score < 40 → "WEAK".
Report the hit rate in key_metrics as "Hit Rate": "<HITS>/<RESOLVED> (<pct>%)".

Return a JSON object conforming EXACTLY to the lens_score schema. Field reference:
{
  "score": <integer 0-100, per SCORE & STATUS DERIVATION>,
  "status": <"STRONG" | "MODERATE" | "WEAK", bucketed from score>,
  "takeaway": <string — max 30 words, action-oriented synthesis leading with the key finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [ <child objects with kind="signal" — see FIELD BANDS> ],
  "patterns":    [ <child objects with kind="pattern" — see FIELD BANDS; [] for non-management lenses> ]
}

Child object fields (shared superset — NO nulls; use sentinels: "" for strings, -1 for numbers):
  kind                — "signal" for top_signals, "pattern" for patterns. REQUIRED.
  signal_id           — id of the signal from the data block; "" if a pure pattern with no single source signal.
  metric              — metric name exactly as provided; "" for patterns without a single metric.
  label               — 2–5 word title-case human-readable label.
  impact              — "high" | "medium" | "low".
  direction           — signal: beat|miss|in_line|unresolvable|none. pattern: positive|negative|neutral|watch.
  statement           — VERBATIM evidence excerpt, <=80 chars; "" if none.
  original_statement  — exact verbatim source sentence; "" if none.
  source_ref          — page / timestamp / PPT slide / Prowess call id for tap-to-verify; "" if unavailable.
  announcement_date   — ISO 8601 (YYYY-MM-DD) when management made the statement; "" if N/A.
  value_targeted      — single-point committed number; -1 if range or none.
  value_targeted_low  — range low; -1 otherwise.
  value_targeted_high — range high; -1 otherwise.
  target_date         — ISO 8601 last day of target period; "" if no deadline.
  actual_value        — realised value verbatim from PPT/Prowess; never calculated; -1 if not reported.
  actual_date         — ISO 8601 last day of reported period; "" if actuals unavailable.
  unit                — "Cr" | "%" | "x" | "bps"; "" if none.
  pattern_type        — one of the 6 pattern types; "none" for kind="signal".
  confidence          — 0.0–1.0 evidence strength of an INCLUDED pattern; -1 for kind="signal".
  confidence_reason   — why this confidence; "" for kind="signal".
  sentence            — full one-line causal claim; "" for kind="signal".
  shape_data          — JSON-stringified shape array; "" if none.
  shape_label         — human label for the shape; "" if none.
  evidence            — array of {period, signal_id, value, quote}; [] for kind="signal". evidence.value = -1 when no numeric count.

For top_signals: select 8–10 signals that most influenced this lens score — include ALL signals that have meaningful analytical value for this lens, not just the top few. For signals with a forward-looking commitment (subject to Source of Truth and the tense gate), populate the guidance band and resolve direction against actual_value when target and actual periods match; otherwise "unresolvable". If no guidance was stated, set all guidance-band numbers to -1 and strings to "" and set direction = "none".

PATTERN ANALYSIS — INDEPENDENT OF GUIDANCE TRACK RECORD:
Behavioral patterns (drumbeat, emergence, narrative_gap, tone_divergence, going_quiet, street_pressure) are a SEPARATE analysis from the guidance track record above. They draw on ALL L1 signals from ALL sources — earnings transcripts (every mention, not just guidance), PPTs, the Prowess API, and annual reports — plus analyst question clustering. Pattern analysis neither reads from nor writes to the top_signals comparison logic; the two are orthogonal.

PATTERN INCLUSION vs CONFIDENCE (reconciled):
- INCLUSION is gated by the v5 Pattern Threshold Table (minimum quarters, mention jumps, gap thresholds). A pattern that does NOT meet its threshold is NOT emitted at all — do not force it.
- For each pattern you DO emit, "confidence" (0.0–1.0) expresses how strong the evidence is: 1.0 = strong multi-quarter evidence with exact quotes and signal IDs; lower = thinner but still threshold-clearing evidence. Never emit a sub-threshold pattern with low confidence — drop it instead.
- Emit patterns for management-style lenses; emit an empty array [] for non-management lenses.

For all dates use strict ISO 8601 format (YYYY-MM-DD) resolved to the last day of the implied period — never use free-text period labels like "FY2026 Q3".
`;

// ─── Per metric_family normalization ranges ───────────────────────────────────

const NORM_RANGES = {
  growth:        { min: -50, max: 50  },
  profitability: { min: -20, max: 40  },
  governance:    { min: 0,   max: 1   },
  ofactor:       { min: 0,   max: 25  },
  management:    { min: 0,   max: 10  },
  customer:      { min: 0,   max: 100 },
  milestone:     { min: 0,   max: 1   },
  capital:       { min: 0,   max: 10  },
};

function normalizeValue(value, metricFamily) {
  const range = NORM_RANGES[metricFamily];
  if (!range) return value;
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (range.max === range.min) return 0;
  return (clamped - range.min) / (range.max - range.min);
}

function computeConfidenceInterval(signals, effectiveWeights) {
  const pairs = signals.map((s, i) => ({ conf: s.confidence ?? 0.7, w: effectiveWeights[i] }));
  const totalW = pairs.reduce((a, b) => a + Math.abs(b.w), 0) || 1;
  const variance = pairs.reduce((acc, { conf, w }) => {
    const uncertainty = 1 - conf;
    return acc + Math.pow(Math.abs(w) / totalW, 2) * Math.pow(uncertainty, 2);
  }, 0);
  const stdDev = Math.sqrt(variance);
  return { lo: -stdDev, hi: stdDev };
}

// ─── buildSignalSummary ──────────────────────────────────────────────────────
// Produces a compact ~20-50 line text block from signals for the L2 LLM prompt.
// Pure math — no LLM.

// balance: optional object from LensConfig.config.balance, e.g. { milestone: 8, governance: 3, default: 3 }
// prefilter: optional object controlling per-type signal filtering before the cap is applied.
//   { milestone: "trackable_only" } — for milestone signals, only include rows with end_date or time_horizon set.
//   This is used by guidance-credibility to drop pure success/failure disclosures that have no target deadline.
function buildSignalSummary(lensName, signals, mathResult, balance, prefilter, opts = {}) {
  const showMath = opts.show_math_block !== false;
  const header   = showMath
    ? `SIGNAL SUMMARY (${signals.length} signals, weighted aggregate z=${mathResult.z_score.toFixed(4)}):`
    : `SIGNAL SUMMARY (${signals.length} signals):`;
  const lines = [
    `LENS: ${lensName}`,
    header,
    '',
  ];

  const groups = new Map();
  for (const s of signals) {
    const t = s.signal_type ?? 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(s);
  }

  const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };
  const QUALITATIVE_TYPES = new Set(['milestone', 'industry', 'financial_health', 'customer']);

  const formatLine = s => {
    const period     = [s.fiscal_year, s.quarter].filter(Boolean).join(' ');
    const periodStr  = period ? ` [${period}]` : '';
    const periodType = s.period_type ? ` period_type=${s.period_type}` : '';
    const dates      = [s.start_date && `start=${s.start_date}`, s.end_date && `end=${s.end_date}`].filter(Boolean).join(' ');
    const datesStr   = dates ? ` (${dates})` : '';
    const impact     = s.impact ? ` impact=${s.impact}` : '';
    const horizon    = s.time_horizon ? ` horizon=${s.time_horizon}` : '';
    const stmt       = s.statement ? ` — "${s.statement}"` : '';
    const displayVal = s.raw_value ?? s.value;
    const unitStr    = s.unit && String(displayVal).includes(s.unit) ? '' : (s.unit ? ' ' + s.unit : '');
    return `  [id=${s.id}] ${s.metric}: ${displayVal}${unitStr}${periodStr}${datesStr} (${s.signal_type}${periodType}${impact}${horizon})${stmt}`;
  };

  for (const [type, groupSignals] of groups) {
    const cap = balance?.[type] ?? balance?.default ?? 100;

    // Apply prefilter before sorting/capping.
    // "trackable_only" keeps only signals with end_date or time_horizon (a target deadline).
    // Signals without either are pure disclosures with no trackable commitment — irrelevant for guidance lenses.
    let eligibleSignals = groupSignals;
    if (prefilter?.[type] === 'trackable_only') {
      eligibleSignals = groupSignals.filter(s => s.end_date != null || s.time_horizon != null);
    }

    // For qualitative signal types (milestone, industry, financial_health): include all signals
    // even when value is null, so the LLM sees the statement text. Sort: signals with end_date first
    // (most trackable), then by impact.
    // For other signal types: keep existing behaviour (value != null filter, sort by impact then end_date).
    let sorted;
    if (QUALITATIVE_TYPES.has(type)) {
      sorted = [...eligibleSignals].sort((a, b) => {
        const aHasDate = a.end_date != null ? 0 : 1;
        const bHasDate = b.end_date != null ? 0 : 1;
        if (aHasDate !== bHasDate) return aHasDate - bHasDate;
        const ia = IMPACT_ORDER[a.impact] ?? 3;
        const ib = IMPACT_ORDER[b.impact] ?? 3;
        return ia - ib;
      });
    } else {
      sorted = eligibleSignals
        .filter(s => s.value != null)
        .sort((a, b) => {
          const ia = IMPACT_ORDER[a.impact] ?? 3;
          const ib = IMPACT_ORDER[b.impact] ?? 3;
          if (ia !== ib) return ia - ib;
          return (a.end_date != null ? 0 : 1) - (b.end_date != null ? 0 : 1);
        });
    }

    const shown = sorted.slice(0, cap);
    const rest  = sorted.slice(cap);

    if (shown.length > 0) {
      lines.push(`  --- ${type.toUpperCase()} signals (${groupSignals.length} total, showing ${shown.length}) ---`);
      for (const s of shown) lines.push(formatLine(s));
    }

    if (rest.length > 0) {
      const summary = rest.map(s => {
        const dates = [s.start_date && `start=${s.start_date}`, s.end_date && `end=${s.end_date}`].filter(Boolean).join(' ');
        return `${s.metric}${dates ? ` (${dates})` : ''}`;
      }).join(', ');
      lines.push(`  ... ${rest.length} more ${type} signals: ${summary}`);
    }
  }

  if (showMath) {
    lines.push('');
    lines.push(`MATH: z=${mathResult.z_score.toFixed(4)}, CI=[${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}], n=${signals.filter(s => s.value != null).length}`);
  }

  return lines.join('\n');
}

// ─── buildPeerSignalsBlock ────────────────────────────────────────────────────
// Fetches entity + industry L1 signals from each peer's latest call (same basic_industry)
// and formats them as a compact text block for injection into the competition / industry-analysis prompt.

// V2 equivalents of old 'entity' + 'industry' signal types
const PEER_SIGNAL_TYPES  = ['industry_signal', 'competitive_position'];
const PEER_SIGNALS_CAP   = 10; // max signals shown per peer ticker (after filtering)
const PEER_IMPACT_ORDER  = { high: 0, medium: 1, low: 2 };

async function buildPeerSignalsBlock(callId, subjectTicker) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { basic_industry: true },
  });
  if (!call?.basic_industry) return '';

  const peerRows = await prisma.earnings_calls.findMany({
    where:   { basic_industry: call.basic_industry, NOT: { company: subjectTicker } },
    select:  { company: true, id: true, fiscal_year: true, quarter: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  // Pick the latest call per peer ticker
  const latestByTicker = new Map();
  for (const r of peerRows) {
    if (!latestByTicker.has(r.company)) latestByTicker.set(r.company, r);
  }
  if (latestByTicker.size === 0) return '';

  const lines = ['\nPEER L1 SIGNALS (competitor + industry signals from peer earnings calls):'];

  for (const [peerTicker, peerCall] of latestByTicker) {
    const raw = await prisma.transcriptSignalV2.findMany({
      where: {
        call_id:        peerCall.id,
        signal_type:    { in: PEER_SIGNAL_TYPES },
        is_invalidated: false,
      },
    });
    if (raw.length === 0) continue;

    // Sort high → medium → low, then by statement presence
    const sorted = raw.sort((a, b) => {
      const ia = PEER_IMPACT_ORDER[a.impact] ?? 3;
      const ib = PEER_IMPACT_ORDER[b.impact] ?? 3;
      if (ia !== ib) return ia - ib;
      return (b.statement ? 1 : 0) - (a.statement ? 1 : 0);
    }).slice(0, PEER_SIGNALS_CAP);

    lines.push(`\n  [${peerTicker} — ${peerCall.fiscal_year} ${peerCall.quarter}]`);
    for (const s of sorted) {
      const data    = s.data ?? {};
      const primary = Array.isArray(data.measures) ? data.measures.find(m => m.value != null) : null;
      const dispVal = primary?.value_raw ?? (primary?.value != null ? String(primary.value) : 'N/A');
      const stmt    = s.statement ? ` — "${s.statement}"` : '';
      lines.push(`    [id=${s.id}] ${s.metric ?? s.signal_type}: ${dispVal} (${s.signal_type} impact=${s.impact ?? 'N/A'})${stmt}`);
    }
  }

  if (lines.length === 1) return ''; // only header, no data
  lines.push('');
  return lines.join('\n');
}

// ─── composeIndustryLens ─────────────────────────────────────────────────────
// industry-analysis is a shared lens: all peers in the same industry receive
// identical lens_data from one LLM call. Steps:
//   1. Build the industry-wide prompt (peer KPIs + peer L1 signals).
//   2. Derive a hash of that shared input.
//   3. If any peer already has a fresh score with the same hash, copy it and return.
//   4. Otherwise call the LLM once, then fan-out to every peer call_id.

const INDUSTRY_LENS_SLUGS = new Set();

async function composeIndustryLens(callId, lensSlug, lensConfig) {
  const {
    model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate,
  } = lensConfig.config;

  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, basic_industry: true },
  });
  if (!call?.basic_industry) {
    console.log(`[lensComposer] "${lensSlug}" — no basic_industry for ${callId}, falling through to per-call compute`);
    return null;
  }

  const { basic_industry: industry } = call;

  // Use only transcript-based call_ids (exclude prowess synthetic ones) so that
  // the fan-out targets the same call_ids that have real L1 signals.
  const allRows = await prisma.$queryRaw`
    SELECT DISTINCT ON (sv.ticker) sv.ticker AS company, sv.call_id AS id, sv.fiscal_year, sv.quarter
    FROM transcript_signals_v2 sv
    WHERE sv.is_invalidated = false
      AND sv.call_id NOT LIKE 'prowess%'
      AND sv.call_id IN (
        SELECT id FROM earnings_calls WHERE basic_industry = ${industry}
      )
    ORDER BY sv.ticker, sv.fiscal_year DESC, sv.quarter DESC
  `;
  const latestCallByTicker = new Map();
  for (const r of allRows) {
    if (!latestCallByTicker.has(r.company)) latestCallByTicker.set(r.company, r);
  }
  const peerCallIds = [...latestCallByTicker.values()].map(r => r.id);

  const pm = await fetchPeerMetrics(callId);
  const peerBlock = formatPeerMetricsBlock(pm);

  const industrySignalLines = ['\nINDUSTRY L1 SIGNALS (all peer earnings calls):'];
  for (const [ticker, peerCall] of latestCallByTicker) {
    const raw = await prisma.transcriptSignalV2.findMany({
      where: {
        call_id:        peerCall.id,
        signal_type:    { in: PEER_SIGNAL_TYPES },
        is_invalidated: false,
      },
    });
    if (raw.length === 0) continue;
    const sorted = raw.sort((a, b) => {
      const ia = PEER_IMPACT_ORDER[a.impact] ?? 3;
      const ib = PEER_IMPACT_ORDER[b.impact] ?? 3;
      if (ia !== ib) return ia - ib;
      return (b.statement ? 1 : 0) - (a.statement ? 1 : 0);
    }).slice(0, PEER_SIGNALS_CAP);
    industrySignalLines.push(`\n  [${ticker} — ${peerCall.fiscal_year} ${peerCall.quarter}]`);
    for (const s of sorted) {
      const data    = s.data ?? {};
      const primary = Array.isArray(data.measures) ? data.measures.find(m => m.value != null) : null;
      const dispVal = primary?.value_raw ?? (primary?.value != null ? String(primary.value) : 'N/A');
      const stmt    = s.statement ? ` — "${s.statement}"` : '';
      industrySignalLines.push(`    [id=${s.id}] ${s.metric ?? s.signal_type}: ${dispVal} (${s.signal_type} impact=${s.impact ?? 'N/A'})${stmt}`);
    }
  }
  const peerSignalsBlock = industrySignalLines.length > 1 ? industrySignalLines.join('\n') + '\n' : '';

  const em = await fetchEquityMetrics(callId);
  const equityBlock = formatEquityMetricsBlock(em);

  const sharedDataBlock = peerBlock + peerSignalsBlock + equityBlock;
  const industryHash = computeSourceHash(sharedDataBlock + lensConfig.version);

  const existingPeerScore = await prisma.lensScore.findFirst({
    where: {
      call_id:       { in: peerCallIds },
      lens_slug:     lensSlug,
      signals_hash:  industryHash,
      lens_config_v: lensConfig.version,
      is_stale:      false,
    },
  });

  if (existingPeerScore?.lens_data && Array.isArray(existingPeerScore.lens_data.top_signals)) {
    console.log(`[lensComposer] Industry cache hit for "${lensSlug}" / "${industry}" — copying from ${existingPeerScore.call_id}`);
    const cachedData = existingPeerScore.lens_data;
    const missingPeerIds = await _getPeerCallIdsWithoutScore(peerCallIds, lensSlug, industryHash, lensConfig.version);
    await _fanOutIndustryScore(missingPeerIds, lensSlug, lensConfig.version, industryHash, cachedData, latestCallByTicker);
    return { ...cachedData, z_score: existingPeerScore.z_score, signals_snapshot: existingPeerScore.signals_snapshot ?? [] };
  }

  const promptTemplate = cfgPromptTemplate || L2_DEFAULT_PROMPT;
  const prompt = promptTemplate
    .replace('{{LENS_NAME}}', lensConfig.name)
    .replace('{{LENS_INSTRUCTIONS}}', '')
    .replace('{{DATA_BLOCK}}', `LENS: ${lensConfig.name}\nINDUSTRY-WIDE ANALYSIS — ${industry}\n` + sharedDataBlock);

  const model     = cfgModel     ?? '~anthropic/claude-haiku-latest';
  const maxTokens = cfgMaxTokens ?? 8000;
  const outputSchema = lensConfig.config.output_schema ?? lensOutputSchema;

  console.log(`[lensComposer] Industry LLM call for "${lensSlug}" / "${industry}" (${peerCallIds.length} peers, prompt: ${prompt.length} chars)`);
  const { text: responseText, usage: industryUsage } = await llmStream({
    model,
    max_tokens:      maxTokens,
    messages:        [{ role: 'user', content: prompt }],
    response_format: outputSchema,
  });
  logUsage(`lensComposer/industry/${lensSlug}`, industryUsage);

  let lensResult;
  try {
    lensResult = parseJson(responseText);
  } catch (e) {
    console.error(`[lensComposer] Failed to parse industry LLM response for "${lensSlug}":`, e.message);
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [], top_signals: [], patterns: [] };
  }

  const numericScore = typeof lensResult.score === 'number' ? lensResult.score / 100 : 0;
  await _fanOutIndustryScore(peerCallIds, lensSlug, lensConfig.version, industryHash, lensResult, latestCallByTicker, numericScore);

  return { ...lensResult, z_score: numericScore, signals_snapshot: [] };
}

async function _getPeerCallIdsWithoutScore(peerCallIds, lensSlug, industryHash, configVersion) {
  const existing = await prisma.lensScore.findMany({
    where: {
      call_id:       { in: peerCallIds },
      lens_slug:     lensSlug,
      signals_hash:  industryHash,
      lens_config_v: configVersion,
      is_stale:      false,
    },
    select: { call_id: true },
  });
  const doneSet = new Set(existing.map(r => r.call_id));
  return peerCallIds.filter(id => !doneSet.has(id));
}

async function _fanOutIndustryScore(callIds, lensSlug, configVersion, industryHash, lensResult, latestCallByTicker, numericScore) {
  if (callIds.length === 0) return;
  const callToTicker = new Map([...latestCallByTicker.values()].map(r => [r.id, r.company]));
  const score = numericScore ?? (typeof lensResult.score === 'number' ? lensResult.score / 100 : 0);

  await Promise.all(callIds.map(cid => {
    const ticker = callToTicker.get(cid) ?? '';
    return prisma.lensScore.upsert({
      where:  { call_id_lens_slug: { call_id: cid, lens_slug: lensSlug } },
      update: {
        ticker,
        z_score:          score,
        confidence_lo:    score,
        confidence_hi:    score,
        signal_count:     0,
        lens_config_v:    configVersion,
        signals_snapshot: [],
        lens_data:        lensResult,
        signals_hash:     industryHash,
        is_stale:         false,
        computed_at:      new Date(),
      },
      create: {
        call_id:          cid,
        ticker,
        lens_slug:        lensSlug,
        z_score:          score,
        confidence_lo:    score,
        confidence_hi:    score,
        signal_count:     0,
        lens_config_v:    configVersion,
        signals_snapshot: [],
        lens_data:        lensResult,
        signals_hash:     industryHash,
      },
    }).catch(err => console.error(`[lensComposer] Fan-out upsert failed for ${cid}:`, err.message));
  }));

  console.log(`[lensComposer] Fan-out complete for "${lensSlug}" — wrote to ${callIds.length} peers`);
}

// ─── composeLens ─────────────────────────────────────────────────────────────

async function composeLens(callId, lensSlug) {
  const lensConfig = await prisma.lensConfig.findUnique({ where: { slug: lensSlug } });
  if (!lensConfig) throw new Error(`LensConfig "${lensSlug}" not found`);
  if (!lensConfig.is_active) throw new Error(`LensConfig "${lensSlug}" is inactive`);

  // Industry-shared lenses: one LLM call for the whole industry, fanned out to all peers
  if (INDUSTRY_LENS_SLUGS.has(lensSlug)) {
    const result = await composeIndustryLens(callId, lensSlug, lensConfig);
    if (result !== null) return result;
    // null = no basic_industry found; fall through to normal per-call path
  }

  const { signal_filters: filters, weights: weightOverrides = [], aggregation = 'weighted_sum',
          model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate,
          balance: cfgBalance, prefilter: cfgPrefilter,
          show_math_block: cfgShowMathBlock } = lensConfig.config;

  const { include_historical, current_call_only_types, ...signalFilters } = filters ?? {};

  const currentSignals = await querySignalsV2({ callId, ...signalFilters });

  let signals = currentSignals;
  if (include_historical) {
    let ticker = currentSignals[0]?.ticker;
    if (!ticker) {
      const anySignal = await prisma.transcriptSignalV2.findFirst({ where: { call_id: callId, is_invalidated: false } });
      ticker = anySignal?.ticker;
    }
    if (ticker) {
      const historicalSignals = await querySignalsV2({ ticker, excludeCallId: callId, ...signalFilters });
      if (historicalSignals.length > 0) {
        console.log(`[lensComposer] "${lensSlug}" — appending ${historicalSignals.length} historical signals for ticker ${ticker}`);
        signals = [...currentSignals, ...historicalSignals];
      }
    }
  }

  const SIGNAL_CAP = 3000;
  if (signals.length > SIGNAL_CAP) {
    console.log(`[lensComposer] "${lensSlug}" — capping signals ${signals.length} → ${SIGNAL_CAP} (current call first)`);
    signals = [...currentSignals, ...signals.filter(s => s.call_id !== callId)].slice(0, SIGNAL_CAP);
  }

  if (signals.length === 0) {
    const empty = {
      score: null, status: 'WEAK', takeaway: 'No signals available for this lens.',
      key_metrics: {}, highlights: [], risks: [], top_signals: [], patterns: [],
      z_score: 0, confidence_lo: 0, confidence_hi: 0, signal_count: 0, signals_snapshot: [],
    };
    await prisma.lensScore.upsert({
      where:  { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
      update: { z_score: 0, confidence_lo: 0, confidence_hi: 0, signal_count: 0,
                lens_config_v: lensConfig.version, lens_data: empty, is_stale: false, computed_at: new Date() },
      create: { call_id: callId, ticker: '', lens_slug: lensSlug, z_score: 0,
                confidence_lo: 0, confidence_hi: 0, signal_count: 0,
                lens_config_v: lensConfig.version, signals_snapshot: [], lens_data: empty },
    });
    return empty;
  }

  // ── Math step ──────────────────────────────────────────────────────────────
  const weightMap = new Map((weightOverrides || []).map(o => [o.metric, { w: o.w ?? 1.0, b: o.b ?? 0.0 }]));
  const effectiveWeights = [];
  let z = 0;
  const snapshot = [];

  for (const sig of signals) {
    if (sig.value == null || isNaN(sig.value)) continue;
    const override     = weightMap.get(sig.metric) ?? { w: sig.w, b: sig.b };
    const normalized   = normalizeValue(sig.value, sig.metric_family);
    const contribution = override.w * normalized + override.b;
    z += contribution;
    effectiveWeights.push(override.w);
    snapshot.push({ signal_id: sig.id, metric: sig.metric, value: sig.value, normalized, w: override.w, b: override.b, contribution });
  }

  if (aggregation === 'avg' && snapshot.length > 0) z = z / snapshot.length;

  const { lo, hi } = computeConfidenceInterval(signals.filter(s => s.value != null), effectiveWeights);
  const mathResult = { z_score: z, confidence_lo: z + lo, confidence_hi: z + hi };

  const ticker = signals[0]?.ticker ?? '';

  // ── L2 cache check by signals_hash ────────────────────────────────────────
  // For promoter-activity, include the shareholding block in the hash so the
  // cache busts whenever the Prowess CSV is updated with new quarterly data.
  const shareholdingHashInput = lensSlug === 'promoter-activity' && ticker
    ? buildShareholdingBlock(ticker)
    : '';
  const signalsHash = computeSourceHash(
    signals.map(s => `${s.id}:${s.value}`).sort().join(',') + shareholdingHashInput
  );

  const existing = await prisma.lensScore.findUnique({
    where: { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
  });
  const cachedLensData = existing?.lens_data;
  const hasCachedTopSignals = Array.isArray(cachedLensData?.top_signals) && Array.isArray(cachedLensData?.patterns);
  if (existing && existing.signals_hash === signalsHash && existing.lens_config_v === lensConfig.version && !existing.is_stale && cachedLensData && hasCachedTopSignals) {
    console.log(`[lensComposer] Cache hit for ${lensSlug}/${callId} — signals_hash match, skipping L2 LLM`);
    return { ...cachedLensData, z_score: existing.z_score, signals_snapshot: existing.signals_snapshot };
  }

  // ── Build compact signal summary → L2 LLM call ───────────────────────────
  const signalSummary = buildSignalSummary(lensConfig.name, signals, mathResult, cfgBalance, cfgPrefilter, { show_math_block: cfgShowMathBlock });
  const promptTemplate = cfgPromptTemplate || L2_DEFAULT_PROMPT;

  const lensInstructions = cfgPromptTemplate ? '' : '';

  // For industry-analysis and competition lenses, append peer KPI context block + peer L1 signals
  let peerBlock = '';
  if (PEER_LENS_SLUGS.has(lensSlug)) {
    const pm = await fetchPeerMetrics(callId);
    peerBlock = formatPeerMetricsBlock(pm);
    peerBlock += await buildPeerSignalsBlock(callId, ticker);
  }

  // For promoter-activity lens, append shareholding pattern from Prowess CSV
  let shareholdingBlock = '';
  if (lensSlug === 'promoter-activity' && ticker) {
    shareholdingBlock = buildShareholdingBlock(ticker);
    if (shareholdingBlock) {
      console.log(`[lensComposer] Appended shareholding block for ${ticker} (${prowess.SH_PERIOD_COUNT} periods)`);
    }
  }

  // For all lenses: append live PE + market-cap context (subject + industry peers)
  const em = await fetchEquityMetrics(callId);
  const equityBlock = formatEquityMetricsBlock(em);

  const cfgBridgePrompt = lensConfig.config.bridge_prompt ?? false;

  let prompt = promptTemplate
    .replace('{{LENS_NAME}}', lensConfig.name)
    .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
    .replace('{{DATA_BLOCK}}', signalSummary + shareholdingBlock + peerBlock + equityBlock);

  // if (cfgBridgePrompt) prompt += JSON_OUTPUT_CONTRACT;

  const model          = cfgModel     ?? 'anthropic/claude-haiku-4.5';
  const maxTokens      = cfgMaxTokens ?? 8000;
  const outputSchema   = lensConfig.config.output_schema ?? lensOutputSchema;

  console.log(`[lensComposer] Calling L2 LLM for lens "${lensSlug}" (${signals.length} signals, prompt: ${prompt.length} chars)`);
  const { text: responseText, usage: l2Usage } = await llmStream({
    model,
    max_tokens:      maxTokens,
    messages:        [{ role: 'user', content: prompt }],
    response_format: outputSchema,
  });
  logUsage(`lensComposer/L2/${lensSlug}`, l2Usage);

  let lensResult;
  try {
    lensResult = parseJson(responseText);
  } catch (e) {
    console.error(`[lensComposer] Failed to parse L2 LLM response for "${lensSlug}":`, e.message);
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [], top_signals: [], patterns: [] };
  }

  // Normalize the score from 0-100 to a z_score; prefer math z_score if LLM score absent
  const numericScore = typeof lensResult.score === 'number' ? lensResult.score / 100 : z;

  // ── Upsert LensScore ──────────────────────────────────────────────────────
  await prisma.lensScore.upsert({
    where:  { call_id_lens_slug: { call_id: callId, lens_slug: lensSlug } },
    update: {
      ticker,
      z_score:          numericScore,
      confidence_lo:    mathResult.confidence_lo,
      confidence_hi:    mathResult.confidence_hi,
      signal_count:     snapshot.length,
      lens_config_v:    lensConfig.version,
      signals_snapshot: snapshot,
      lens_data:        lensResult,
      signals_hash:     signalsHash,
      is_stale:         false,
      computed_at:      new Date(),
    },
    create: {
      call_id:          callId,
      ticker,
      lens_slug:        lensSlug,
      z_score:          numericScore,
      confidence_lo:    mathResult.confidence_lo,
      confidence_hi:    mathResult.confidence_hi,
      signal_count:     snapshot.length,
      lens_config_v:    lensConfig.version,
      signals_snapshot: snapshot,
      lens_data:        lensResult,
      signals_hash:     signalsHash,
    },
  });

  return { ...lensResult, z_score: numericScore, signals_snapshot: snapshot };
}

// ─── composeAllLenses ────────────────────────────────────────────────────────

async function composeAllLenses(callId) {
  const configs = await prisma.lensConfig.findMany({ where: { is_active: true } });
  const results = await Promise.all(
    configs.map(cfg => composeLens(callId, cfg.slug).catch(err => {
      console.error(`[lensComposer] Error composing lens "${cfg.slug}" for ${callId}:`, err.message);
      return null;
    }))
  );
  return Object.fromEntries(
    configs.map((cfg, i) => [cfg.slug, results[i]]).filter(([, v]) => v !== null)
  );
}

async function markLensesStale(callId) {
  const result = await prisma.lensScore.updateMany({
    where: { call_id: callId, is_stale: false },
    data:  { is_stale: true },
  });
  return result.count;
}

async function markLensStaleBySlug(lensSlug) {
  const result = await prisma.lensScore.updateMany({
    where: { lens_slug: lensSlug, is_stale: false },
    data:  { is_stale: true },
  });
  return result.count;
}

async function getLensScores(callId) {
  return prisma.lensScore.findMany({
    where:   { call_id: callId, is_stale: false },
    orderBy: { lens_slug: 'asc' },
  });
}

/**
 * Return lens scores for a call grouped by LensConfig.category.
 * Each group lists lenses in alphabetical order.
 * Scores include the full lens_data plus z_score/signal_count metadata.
 *
 * @param {string} callId
 * @param {string} [category]  Optional filter — only return one category
 * @returns {Promise<object>}  { callId, categories: { management: [...], opportunity: [...], deal: [...] } }
 */
async function getLensesByCategory(callId, category) {
  const configWhere = { is_active: true };
  if (category) configWhere.category = category;

  // Fetch configs and scores in parallel; scores need the slugs list but we can query all
  // non-stale scores for this callId without filtering by slug and intersect in-memory
  const [configs, allScores] = await Promise.all([
    prisma.lensConfig.findMany({ where: configWhere, orderBy: { slug: 'asc' } }),
    prisma.lensScore.findMany({ where: { call_id: callId, is_stale: false }, orderBy: { lens_slug: 'asc' } }),
  ]);

  if (configs.length === 0) return { callId, categories: {} };

  const scores = allScores.filter(s => configs.some(c => c.slug === s.lens_slug));
  const scoreMap = new Map(scores.map(s => [s.lens_slug, s]));

  const categories = {};
  for (const cfg of configs) {
    const cat = cfg.category ?? 'uncategorized';
    if (!categories[cat]) categories[cat] = [];
    const ls  = scoreMap.get(cfg.slug);
    const ld  = ls?.lens_data ?? {};
    categories[cat].push({
      slug:         cfg.slug,
      name:         cfg.name,
      description:  cfg.description,
      category:     cat,
      computed:     !!ls,
      score:        ld.score        ?? null,
      status:       ld.status       ?? null,
      takeaway:     ld.takeaway     ?? null,
      key_metrics:  ld.key_metrics  ?? {},
      highlights:   ld.highlights   ?? [],
      risks:        ld.risks        ?? [],
      top_signals:  ld.top_signals  ?? [],
      patterns:     ld.patterns     ?? [],
      z_score:      ls?.z_score     ?? null,
      signal_count: ls?.signal_count ?? 0,
      computed_at:  ls?.computed_at  ?? null,
    });
  }

  for (const cat of Object.keys(categories)) {
    categories[cat] = sortLensesByConfig(categories[cat], cat);
  }

  return { callId, categories };
}

module.exports = {
  composeLens,
  composeAllLenses,
  markLensesStale,
  markLensStaleBySlug,
  getLensScores,
  getLensesByCategory,
  // Exported for debug scripts
  buildSignalSummary,
  buildShareholdingBlock,
  normalizeValue,
  computeConfidenceInterval,
  L2_DEFAULT_PROMPT,
};
