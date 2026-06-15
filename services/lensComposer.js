'use strict';

const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { sortLensesByConfig } = require('../lib/insightLenses');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { lensOutputSchema } = require('../outputSchemas/lens');
const { computeSourceHash } = require('../utils/sourceHash');
const { fetchPeerMetrics, formatPeerMetricsBlock, fetchEquityMetrics, formatEquityMetricsBlock } = require('./peerMetrics');
const prowess = require('../lib/prowess');

const PEER_LENS_SLUGS = new Set(['competition']);

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

const L2_DEFAULT_PROMPT = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.
{{LENS_INSTRUCTIONS}}
{{DATA_BLOCK}}

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 30 words, action-oriented, lead with the key finding (e.g. "Margins expanding on operating leverage; FCF conversion risk remains — watch CFO/PAT ratio.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "EBITDA margin up 180 bps YoY on cost discipline.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Debt elevated; interest cover below 3x for 2 quarters.")
- "label" in top_signals: 2–5 words, title-case, human-readable (e.g. "Operating Cash Flow")
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 30 words, action-oriented synthesis leading with the key finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [
    {
      "signal_id": <string — id of the signal from the data block>,
      "metric": <string — metric name exactly as provided>,
      "label": <string — 2–5 word title-case human-readable label>,
      "announcement_date": <string — ISO 8601 date YYYY-MM-DD when management made this statement; OMIT this field entirely if not applicable>,
      "value_at_announcement": <number — the actual metric value at the time management made the statement (what things looked like when they said it); OMIT this field entirely if not available>,
      "value_targeted": <number — the number management committed to achieving; OMIT this field entirely if not applicable>,
      "target_date": <string — ISO 8601 date YYYY-MM-DD, last day of the period by which the target must be achieved, e.g. "2027-03-31" for FY2027, "2026-09-30" for FY2026 Q3; OMIT this field entirely if no deadline exists>,
      "actual_value": <number — realised/reported value; OMIT this field entirely if not yet reported>,
      "actual_date": <string — ISO 8601 date YYYY-MM-DD, last day of the reported period, e.g. "2026-09-30" for FY2026 Q3, "2026-03-31" for FY2026; OMIT this field entirely if actuals not yet available>,
      "unit": <string — e.g. "Cr", "%", "x"; OMIT this field entirely if no unit applies>,
      "delta": <number — actual_value minus value_targeted; positive means beat, negative means miss; OMIT this field entirely if only one side available>,
      "delta_pct": <number — percentage delta relative to value_targeted; OMIT this field entirely if not computable>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" — "tracking" when guidance exists but actuals not yet due; OMIT this field entirely if not applicable>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — key evidence quote from the source, ≤80 chars>,
      "original_statement": <string | null — exact verbatim sentence from the Data Block that this signal is sourced from>
    }
  ]
}

For top_signals: select 8–10 signals that most influenced this lens score — include ALL signals that have meaningful analytical value for this lens, not just the top few. For signals where management gave a forward-looking promise (guidance), populate value_targeted/target_date and compare against actual_value if the period has passed. If no actual is available yet, set direction to "tracking". For all dates use strict ISO 8601 format (YYYY-MM-DD) resolved to the last day of the implied period — never use free-text period labels like "FY2026 Q3".`;

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

// ─── end_date → fiscal period mapping ────────────────────────────────────────
// Maps any calendar date to the Indian fiscal quarter it falls in.
// FY convention: FY2026 = Apr 2025 – Mar 2026 (Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar)
function endDateToFiscalPeriod(endDate) {
  const d    = new Date(endDate);
  const mon  = d.getMonth() + 1; // 1–12
  const year = d.getFullYear();
  if (mon <= 3) return { fy: `FY${year}`,     quarter: 'Q4' }; // Jan–Mar
  if (mon <= 6) return { fy: `FY${year + 1}`, quarter: 'Q1' }; // Apr–Jun
  if (mon <= 9) return { fy: `FY${year + 1}`, quarter: 'Q2' }; // Jul–Sep
  return             { fy: `FY${year + 1}`, quarter: 'Q3' };   // Oct–Dec
}

// Returns the UTC last day of the quarter AFTER the call's own quarter.
// A milestone with end_date <= this value is either a same-quarter disclosure (Tier 3)
// or a single-quarter-ahead near-term update — neither is a meaningful multi-period commitment.
// Using the following quarter's last day (not the call quarter's) avoids exact-boundary
// timezone issues and trims low-value single-step guidance in one step.
// Indian FY: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
// Examples: call=FY2026 Q2 → cutoff = Dec 31 2025 (Q3 last day)
//           call=FY2026 Q4 → cutoff = Jun 30 2026 (Q1 FY2027 last day)
function milestoneExclusionCutoff(fiscalYear, quarter) {
  const fy = parseInt((fiscalYear ?? '').replace('FY', ''));
  if (!fy || !quarter) return null;
  // Advance one quarter, carrying FY forward at Q4→Q1 boundary
  const NEXT_Q = { Q1: 'Q2', Q2: 'Q3', Q3: 'Q4', Q4: 'Q1' };
  const nextQ  = NEXT_Q[quarter];
  if (!nextQ) return null;
  const nextFY = (quarter === 'Q4') ? fy + 1 : fy;
  const calYear = (nextQ === 'Q4') ? nextFY : nextFY - 1;
  if (nextQ === 'Q1') return new Date(Date.UTC(calYear, 5,  30)); // Jun 30
  if (nextQ === 'Q2') return new Date(Date.UTC(calYear, 8,  30)); // Sep 30
  if (nextQ === 'Q3') return new Date(Date.UTC(calYear, 11, 31)); // Dec 31
  if (nextQ === 'Q4') return new Date(Date.UTC(calYear, 2,  31)); // Mar 31
  return null;
}

// ─── Source priority deduplication ───────────────────────────────────────────
// When the same metric/period appears from multiple sources, keep the most
// authoritative one. prowess = audited financials > qe = interim PDF > transcript = LLM extract.

const SOURCE_PRIORITY = { prowess: 0, qe: 1, transcript: 2 };

function deduplicateSignals(signals) {
  const best = new Map();
  for (const sig of signals) {
    const key = `${sig.metric}|${sig.fiscal_year ?? ''}|${sig.quarter ?? ''}|${sig.start_date ?? ''}|${sig.end_date ?? ''}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, sig);
    } else {
      const existingPrio = SOURCE_PRIORITY[existing.source_type] ?? 99;
      const sigPrio      = SOURCE_PRIORITY[sig.source_type]      ?? 99;
      if (sigPrio < existingPrio) best.set(key, sig);
    }
  }
  return [...best.values()];
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

const INDUSTRY_LENS_SLUGS = new Set(['industry-analysis']);

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
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [], top_signals: [] };
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
          balance: cfgBalance, prefilter: cfgPrefilter, kpi_filter: cfgKpiFilter,
          milestone_prefilter: cfgMilestonePrefilter,
          governance_metric_allowlist: cfgGovernanceMetricAllowlist,
          show_math_block: cfgShowMathBlock } = lensConfig.config;


  const { include_historical, current_call_only_types, ...signalFilters } = filters ?? {};

  const currentSignals = await querySignalsV2({ callId, ...signalFilters });

  let signals = currentSignals;
  if (include_historical) {
    // Resolve ticker from current signals; if none matched the filter, fall back to any signal on this call
    let ticker = currentSignals[0]?.ticker;
    if (!ticker) {
      const anySignal = await prisma.transcriptSignalV2.findFirst({ where: { call_id: callId, is_invalidated: false } });
      ticker = anySignal?.ticker;
    }
    if (ticker) {
      // current_call_only_types are excluded from the historical query (e.g. 'kpi' prowess data
      // spans all periods — only the current call's kpis are relevant for guidance tracking)
      const historicalFilters = { ...signalFilters };
      if (current_call_only_types?.length > 0 && historicalFilters.signal_types) {
        historicalFilters.signal_types = historicalFilters.signal_types.filter(
          t => !current_call_only_types.includes(t)
        );
      }
      if (!historicalFilters.signal_types || historicalFilters.signal_types.length > 0) {
        const historicalSignals = await querySignalsV2({ ticker, excludeCallId: callId, ...historicalFilters });
        if (historicalSignals.length > 0) {
          console.log(`[lensComposer] "${lensSlug}" — appending ${historicalSignals.length} historical signals for ticker ${ticker}`);
          signals = [...currentSignals, ...historicalSignals];
        }
      }
    }
  }

  const deduped = deduplicateSignals(signals);
  if (deduped.length < signals.length) {
    console.log(`[lensComposer] "${lensSlug}" — dropped ${signals.length - deduped.length} duplicate signals (prowess > qe > transcript)`);
  }
  signals = deduped;

  // Milestone pre-filter: drop milestones that are not forward-looking commitments.
  // "trackable_forward_only" keeps only milestones that have:
  //   (a) end_date strictly after the signal's own call-quarter last day (true forward guidance), OR
  //   (b) time_horizon set but no end_date (soft forward commitment, no hard deadline).
  // Drops: pure disclosure milestones (no end_date, no time_horizon) and same-quarter snapshots (Tier 3).
  // Runs BEFORE kpi_filter so the reduced milestone set also trims which KPI actuals are pulled in.
  if (cfgMilestonePrefilter === 'trackable_forward_only') {
    const msBefore = signals.filter(s => s.signal_type === 'milestone').length;
    const totalBefore = signals.length;
    signals = signals.filter(s => {
      if (s.signal_type !== 'milestone') return true;
      if (s.end_date == null && s.time_horizon == null) return false;
      if (s.end_date != null) {
        const lastDay = milestoneExclusionCutoff(s.fiscal_year, s.quarter);
        if (lastDay && new Date(s.end_date) <= lastDay) return false;
      }
      return true;
    });
    const msAfter = signals.filter(s => s.signal_type === 'milestone').length;
    console.log(`[lensComposer] "${lensSlug}" milestone_prefilter=trackable_forward_only — milestones ${msBefore} → ${msAfter}, total ${totalBefore} → ${signals.length}`);
  }

  // Governance metric allowlist: drop governance signals whose metric is not in the approved list.
  // Keeps signal_types intact for other lenses — only activates when the config key is present.
  if (cfgGovernanceMetricAllowlist?.length > 0) {
    const allowSet = new Set(cfgGovernanceMetricAllowlist.map(m => m.toUpperCase()));
    const govBefore = signals.filter(s => s.signal_type === 'governance').length;
    signals = signals.filter(s => s.signal_type !== 'governance' || allowSet.has((s.metric ?? '').toUpperCase()));
    const govAfter = signals.filter(s => s.signal_type === 'governance').length;
    if (govBefore !== govAfter) {
      console.log(`[lensComposer] "${lensSlug}" governance_metric_allowlist — dropped ${govBefore - govAfter} governance signals`);
    }
  }

  // After dedup: surgical KPI filter.
  // - Transcript KPIs: keep all whose metric appears in any milestone signal.
  // - Prowess KPIs:    keep only where (metric, fiscal_year, quarter) matches a milestone end_date period.
  //   This gives exact actuals for the quarter management was targeting — no historical sprawl.
  if (cfgKpiFilter === 'milestone_metrics_only') {
    const milestoneSignals = signals.filter(s => s.signal_type === 'milestone');
    const milestoneMetrics = new Set(milestoneSignals.map(s => s.metric));

    // Build set of "METRIC|FY2025|Q4" keys from milestone end_dates for surgical prowess matching
    const milestoneEndPeriods = new Set();
    for (const m of milestoneSignals) {
      if (!m.end_date || !m.metric) continue;
      const { fy, quarter } = endDateToFiscalPeriod(m.end_date);
      if (fy && quarter) milestoneEndPeriods.add(`${m.metric}|${fy}|${quarter}`);
    }

    const before = signals.length;
    signals = signals.filter(s => {
      if (s.signal_type !== 'kpi') return true;                         // non-KPI: unchanged
      if (!milestoneMetrics.has(s.metric)) return false;               // metric not in milestones: drop
      if (s.source_type !== 'prowess') return true;                    // transcript/qe KPI: keep all
      // prowess KPI: only keep if its period matches a milestone end_date
      return milestoneEndPeriods.has(`${s.metric}|${s.fiscal_year}|${s.quarter}`);
    });

    console.log(`[lensComposer] "${lensSlug}" kpi_filter=milestone_metrics_only — kept ${signals.length} / ${before} KPI signals (transcript: all matching, prowess: end_date-period only)`);
  }

  if (signals.length === 0) {
    const empty = {
      score: null, status: 'WEAK', takeaway: 'No signals available for this lens.',
      key_metrics: {}, highlights: [], risks: [], top_signals: [],
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
  const hasCachedTopSignals = Array.isArray(cachedLensData?.top_signals);
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

  const prompt = promptTemplate
    .replace('{{LENS_NAME}}', lensConfig.name)
    .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
    .replace('{{DATA_BLOCK}}', signalSummary + shareholdingBlock + peerBlock + equityBlock);

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
    lensResult = { score: null, status: 'WEAK', takeaway: 'Parsing error — see logs.', key_metrics: {}, highlights: [], risks: [], top_signals: [] };
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
};
