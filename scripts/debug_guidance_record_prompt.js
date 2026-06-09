#!/usr/bin/env node
'use strict';

/**
 * Debug: build the guidance-credibility L2 prompt for any ticker and save it to a file.
 * Mirrors the exact flow of composeLens() in services/lensComposer.js — no LLM call made.
 *
 * Usage:
 *   node scripts/debug_guidance_record_prompt.js RELIANCE
 *   node scripts/debug_guidance_record_prompt.js RELIANCE /tmp/my_output.txt
 *   node scripts/debug_guidance_record_prompt.js RELIANCE - growth-momentum   # different lens
 */

require('dotenv').config();
const fs               = require('fs');
const { PrismaClient } = require('@prisma/client');
const { querySignals } = require('../services/db/signals.db');
const { fetchEquityMetrics, formatEquityMetricsBlock } = require('../services/peerMetrics');

const TICKER      = process.argv[2] || 'RELIANCE';
const OUTPUT_FILE = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : `/tmp/guidance_prompt_${TICKER}.txt`;
const LENS_SLUG   = process.argv[4] || 'guidance-credibility';

// ─── Helpers (inlined from lensComposer — keep in sync) ──────────────────────

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
  const pairs  = signals.map((s, i) => ({ conf: s.confidence ?? 0.7, w: effectiveWeights[i] }));
  const totalW = pairs.reduce((a, b) => a + Math.abs(b.w), 0) || 1;
  const variance = pairs.reduce((acc, { conf, w }) => {
    const uncertainty = 1 - conf;
    return acc + Math.pow(Math.abs(w) / totalW, 2) * Math.pow(uncertainty, 2);
  }, 0);
  return { lo: -Math.sqrt(variance), hi: Math.sqrt(variance) };
}

const SOURCE_PRIORITY = { prowess: 0, qe: 1, transcript: 2 };

function endDateToFiscalPeriod(endDate) {
  const d = new Date(endDate), mon = d.getMonth() + 1, year = d.getFullYear();
  if (mon <= 3) return { fy: `FY${year}`,     quarter: 'Q4' };
  if (mon <= 6) return { fy: `FY${year + 1}`, quarter: 'Q1' };
  if (mon <= 9) return { fy: `FY${year + 1}`, quarter: 'Q2' };
  return             { fy: `FY${year + 1}`, quarter: 'Q3' };
}

function milestoneExclusionCutoff(fiscalYear, quarter) {
  const fy = parseInt((fiscalYear ?? '').replace('FY', ''));
  if (!fy || !quarter) return null;
  const NEXT_Q = { Q1: 'Q2', Q2: 'Q3', Q3: 'Q4', Q4: 'Q1' };
  const nextQ  = NEXT_Q[quarter];
  if (!nextQ) return null;
  const nextFY  = (quarter === 'Q4') ? fy + 1 : fy;
  const calYear = (nextQ === 'Q4') ? nextFY : nextFY - 1;
  if (nextQ === 'Q1') return new Date(Date.UTC(calYear, 5,  30)); // Jun 30
  if (nextQ === 'Q2') return new Date(Date.UTC(calYear, 8,  30)); // Sep 30
  if (nextQ === 'Q3') return new Date(Date.UTC(calYear, 11, 31)); // Dec 31
  if (nextQ === 'Q4') return new Date(Date.UTC(calYear, 2,  31)); // Mar 31
  return null;
}

function applyKpiFilter(signals) {
  const milestoneSignals  = signals.filter(s => s.signal_type === 'milestone');
  const milestoneMetrics  = new Set(milestoneSignals.map(s => s.metric));
  const milestoneEndPeriods = new Set();
  for (const m of milestoneSignals) {
    if (!m.end_date || !m.metric) continue;
    const { fy, quarter } = endDateToFiscalPeriod(m.end_date);
    if (fy && quarter) milestoneEndPeriods.add(`${m.metric}|${fy}|${quarter}`);
  }
  const before = signals.length;
  const filtered = signals.filter(s => {
    if (s.signal_type !== 'kpi') return true;
    if (!milestoneMetrics.has(s.metric)) return false;
    if (s.source_type !== 'prowess') return true;
    return milestoneEndPeriods.has(`${s.metric}|${s.fiscal_year}|${s.quarter}`);
  });
  const kpiBefore = signals.filter(s => s.signal_type === 'kpi').length;
  const kpiAfter  = filtered.filter(s => s.signal_type === 'kpi').length;
  console.log(`  kpi_filter=milestone_metrics_only`);
  console.log(`    Milestone metrics : ${milestoneMetrics.size} unique`);
  console.log(`    Milestone periods : ${milestoneEndPeriods.size} end_date periods`);
  console.log(`    KPI before filter : ${kpiBefore}`);
  console.log(`    KPI after filter  : ${kpiAfter}  (transcript: all matching, prowess: period-matched only)`);
  console.log(`    Total signals     : ${before} → ${filtered.length}`);
  return filtered;
}

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

const IMPACT_ORDER     = { high: 0, medium: 1, low: 2 };
const QUALITATIVE_TYPES = new Set(['milestone', 'industry', 'financial_health', 'customer']);

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

    let eligibleSignals = groupSignals;
    if (prefilter?.[type] === 'trackable_only') {
      eligibleSignals = groupSignals.filter(s => s.end_date != null || s.time_horizon != null);
    }

    let sorted;
    if (QUALITATIVE_TYPES.has(type)) {
      sorted = [...eligibleSignals].sort((a, b) => {
        const aHasDate = a.end_date != null ? 0 : 1;
        const bHasDate = b.end_date != null ? 0 : 1;
        if (aHasDate !== bHasDate) return aHasDate - bHasDate;
        return (IMPACT_ORDER[a.impact] ?? 3) - (IMPACT_ORDER[b.impact] ?? 3);
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
      lines.push(`  --- ${type.toUpperCase()} signals (${groupSignals.length} total, showing ${shown.length}${eligibleSignals.length < groupSignals.length ? `, prefiltered from ${eligibleSignals.length}` : ''}) ---`);
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

// ─── Banner ───────────────────────────────────────────────────────────────────

function banner(title) {
  const line = '═'.repeat(70);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

// ─── L2 default prompt (kept in sync with lensComposer.js) ───────────────────

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
      "guided_value": <number | null — management's forward-looking commitment or guidance, if present>,
      "guided_date": <string | null — ISO 8601 date YYYY-MM-DD, last day of the guidance target period, e.g. "2027-03-31" for FY2027, "2026-09-30" for FY2026 Q3>,
      "actual_value": <number | null — realised/reported value>,
      "actual_date": <string | null — ISO 8601 date YYYY-MM-DD, last day of the reported period, e.g. "2026-09-30" for FY2026 Q3, "2026-03-31" for FY2026>,
      "unit": <string | null — e.g. "Cr", "%", "x">,
      "delta": <number | null — actual_value minus guided_value; positive means beat, negative means miss; null if only one side available>,
      "delta_pct": <number | null — percentage delta relative to guided_value; null if not computable>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null — "tracking" when guidance exists but actuals not yet due>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — key evidence quote from the source, ≤80 chars>
    }
  ]
}

For top_signals: select 8–10 signals that most influenced this lens score — include ALL signals that have meaningful analytical value for this lens, not just the top few. For signals where management gave a forward-looking promise (guidance), populate guided_value/guided_date and compare against actual_value if the period has passed. If no actual is available yet, set direction to "tracking". For all dates use strict ISO 8601 format (YYYY-MM-DD) resolved to the last day of the implied period — never use free-text period labels like "FY2026 Q3".`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();

  try {
    // ── Step 1: Load lens config from DB ─────────────────────────────────────
    banner(`Step 1 — Load lens config "${LENS_SLUG}" from DB`);

    const lensConfig = await prisma.lensConfig.findUnique({ where: { slug: LENS_SLUG } });
    if (!lensConfig) {
      console.error(`  ✗ LensConfig "${LENS_SLUG}" not found in DB`);
      process.exit(1);
    }
    if (!lensConfig.is_active) {
      console.error(`  ✗ LensConfig "${LENS_SLUG}" is inactive`);
      process.exit(1);
    }

    console.log(`  ✓ name      : ${lensConfig.name}`);
    console.log(`  ✓ version   : ${lensConfig.version}`);
    console.log(`  ✓ model     : ${lensConfig.config.model ?? '(default)'}`);
    console.log(`  ✓ max_tokens: ${lensConfig.config.max_tokens ?? '(default 8000)'}`);
    console.log(`  ✓ balance   : ${JSON.stringify(lensConfig.config.balance ?? '(default 15)' )}`);
    console.log(`  ✓ prefilter : ${JSON.stringify(lensConfig.config.prefilter ?? '(none)')}`);
    console.log(`  ✓ current_call_only_types: ${JSON.stringify(lensConfig.config.signal_filters?.current_call_only_types ?? [])}`);
    console.log(`  ✓ prompt_template: ${lensConfig.config.prompt_template ? `${lensConfig.config.prompt_template.length} chars` : '(null — using L2_DEFAULT_PROMPT)'}`);

    const { signal_filters: filters, weights: weightOverrides = [], aggregation = 'weighted_sum',
            model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate,
            balance: cfgBalance, prefilter: cfgPrefilter, kpi_filter: cfgKpiFilter,
            milestone_prefilter: cfgMilestonePrefilter,
            governance_metric_allowlist: cfgGovernanceMetricAllowlist,
            show_math_block: cfgShowMathBlock } = lensConfig.config;

    const { include_historical, current_call_only_types, ...signalFilters } = filters ?? {};

    // ── Step 2: Find latest call for ticker ───────────────────────────────────
    banner(`Step 2 — Latest earnings call for ${TICKER}`);

    const latestCall = await prisma.earnings_calls.findFirst({
      where: {
        company: TICKER,
        OR: [
          { transcript_text: { not: null }, NOT: { transcript_text: '' } },
          { ppt_text:        { not: null }, NOT: { ppt_text: ''        } },
        ],
      },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });

    if (!latestCall) {
      console.error(`  ✗ No earnings call with text found for ticker "${TICKER}"`);
      process.exit(1);
    }

    const callId = latestCall.id;
    console.log(`  ✓ callId    : ${callId}`);
    console.log(`  ✓ period    : ${latestCall.fiscal_year} ${latestCall.quarter}`);
    console.log(`  ✓ call_date : ${latestCall.call_date}`);

    // ── Step 3: Query signals (same as composeLens) ───────────────────────────
    banner(`Step 3 — Query signals (current call)`);

    const currentSignals = await querySignals({ callId, ...signalFilters });
    console.log(`  Current call signals: ${currentSignals.length}`);
    const byType = {};
    for (const s of currentSignals) byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
    Object.entries(byType).forEach(([t, n]) => console.log(`    ${t.padEnd(22)} : ${n}`));

    // ── Step 4: Historical signals ────────────────────────────────────────────
    banner(`Step 4 — Historical signals (include_historical=${include_historical ?? false}, current_call_only_types=${JSON.stringify(current_call_only_types ?? [])})`);

    let signals = currentSignals;
    if (include_historical) {
      let ticker = currentSignals[0]?.ticker;
      if (!ticker) {
        const anySignal = await prisma.extractedSignal.findFirst({ where: { call_id: callId, is_invalidated: false } });
        ticker = anySignal?.ticker;
      }
      if (ticker) {
        const historicalFilters = { ...signalFilters };
        if (current_call_only_types?.length > 0 && historicalFilters.signal_types) {
          historicalFilters.signal_types = historicalFilters.signal_types.filter(
            t => !current_call_only_types.includes(t)
          );
          console.log(`  Excluding ${current_call_only_types.join(', ')} from historical query → signal_types: ${JSON.stringify(historicalFilters.signal_types)}`);
        }
        if (!historicalFilters.signal_types || historicalFilters.signal_types.length > 0) {
          const historicalSignals = await querySignals({ ticker, excludeCallId: callId, ...historicalFilters });
          console.log(`  Historical signals: ${historicalSignals.length} (ticker=${ticker})`);
          if (historicalSignals.length > 0) {
            const histCalls = [...new Set(historicalSignals.map(s => `${s.call_id} (${s.fiscal_year} ${s.quarter ?? ''})`))];
            console.log(`  Historical calls: ${histCalls.slice(0, 5).join(', ')}${histCalls.length > 5 ? ` … +${histCalls.length - 5} more` : ''}`);
            signals = [...currentSignals, ...historicalSignals];
          }
        }
      } else {
        console.log('  (could not resolve ticker — skipping historical)');
      }
    } else {
      console.log('  (include_historical=false — skipped)');
    }

    // ── Step 5: Deduplicate ───────────────────────────────────────────────────
    banner('Step 5 — Deduplication (prowess > qe > transcript)');
    const deduped = deduplicateSignals(signals);
    console.log(`  Before: ${signals.length}  →  After: ${deduped.length}  (dropped: ${signals.length - deduped.length})`);
    signals = deduped;

    // ── Step 5a: Milestone pre-filter ─────────────────────────────────────────
    if (cfgMilestonePrefilter === 'trackable_forward_only') {
      banner(`Step 5a — Milestone pre-filter (trackable_forward_only)`);
      const msBefore    = signals.filter(s => s.signal_type === 'milestone').length;
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
      const msAfter    = signals.filter(s => s.signal_type === 'milestone').length;
      const msDropped  = msBefore - msAfter;
      console.log(`  Milestones before : ${msBefore}`);
      console.log(`  Milestones after  : ${msAfter}  (dropped ${msDropped})`);
      console.log(`  Total             : ${totalBefore} → ${signals.length}`);
    }

    // ── Step 5b-gov: Governance metric allowlist ──────────────────────────────
    if (cfgGovernanceMetricAllowlist?.length > 0) {
      const allowSet  = new Set(cfgGovernanceMetricAllowlist.map(m => m.toUpperCase()));
      const govBefore = signals.filter(s => s.signal_type === 'governance').length;
      signals = signals.filter(s => s.signal_type !== 'governance' || allowSet.has((s.metric ?? '').toUpperCase()));
      const govAfter  = signals.filter(s => s.signal_type === 'governance').length;
      console.log(`\n  governance_metric_allowlist: ${govBefore} → ${govAfter} (dropped ${govBefore - govAfter})`);
    }

    // ── Step 5d: KPI filter ───────────────────────────────────────────────────
    if (cfgKpiFilter === 'milestone_metrics_only') {
      banner('Step 5b — KPI filter (milestone_metrics_only + surgical prowess)');
      signals = applyKpiFilter(signals);
    }

    // ── Step 6: Math step ─────────────────────────────────────────────────────
    banner('Step 6 — Math (weighted sum)');

    const weightMap = new Map((weightOverrides || []).map(o => [o.metric, { w: o.w ?? 1.0, b: o.b ?? 0.0 }]));
    const effectiveWeights = [];
    let z = 0;
    const snapshot = [];

    for (const sig of signals) {
      if (sig.value == null || isNaN(sig.value)) continue;
      const override     = weightMap.get(sig.metric) ?? { w: sig.w, b: sig.b };
      const normalized   = normalizeValue(sig.value, sig.metric_family);
      const contribution = override.w * normalized + (override.b ?? 0);
      z += contribution;
      effectiveWeights.push(override.w);
      snapshot.push({ metric: sig.metric, value: sig.value, normalized, w: override.w, contribution });
    }

    if (aggregation === 'avg' && snapshot.length > 0) z = z / snapshot.length;

    const { lo, hi } = computeConfidenceInterval(signals.filter(s => s.value != null), effectiveWeights);
    const mathResult = { z_score: z, confidence_lo: z + lo, confidence_hi: z + hi };

    console.log(`  z_score      : ${z.toFixed(4)}`);
    console.log(`  CI           : [${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}]`);
    console.log(`  n (numeric)  : ${snapshot.length}`);
    if (snapshot.length > 0) {
      console.log('\n  Weight contributions:');
      snapshot.forEach(s =>
        console.log(`    ${s.metric.padEnd(28)} value=${s.value} norm=${s.normalized.toFixed(4)} w=${s.w} contrib=${s.contribution.toFixed(4)}`)
      );
    }

    // ── Step 7: Signal analysis ───────────────────────────────────────────────
    banner('Step 7 — Signal analysis');

    const milestoneSignals      = signals.filter(s => s.signal_type === 'milestone');
    const governanceSignals     = signals.filter(s => s.signal_type === 'governance');
    const financialHealthSignals = signals.filter(s => s.signal_type === 'financial_health');
    const customerSignals       = signals.filter(s => s.signal_type === 'customer');
    const withEndDate           = milestoneSignals.filter(s => s.end_date != null);
    const withTimeHorizon       = milestoneSignals.filter(s => s.time_horizon != null);
    const trackable             = milestoneSignals.filter(s => s.end_date != null || s.time_horizon != null);

    console.log(`  MILESTONE signals    : ${milestoneSignals.length}`);
    console.log(`    → with end_date    : ${withEndDate.length}`);
    console.log(`    → with time_horizon: ${withTimeHorizon.length}`);
    console.log(`    → trackable (either): ${trackable.length}  ← prefilter will keep these`);
    console.log(`    → dropped by prefilter: ${milestoneSignals.length - trackable.length}`);
    const govByMetric = {};
    for (const s of governanceSignals) {
      const k = s.metric?.toUpperCase() ?? 'UNKNOWN';
      govByMetric[k] = (govByMetric[k] || 0) + 1;
    }
    console.log(`  GOVERNANCE signals   : ${governanceSignals.length}`);
    Object.entries(govByMetric).sort((a,b) => b[1]-a[1])
      .forEach(([m, n]) => console.log(`    → ${m.padEnd(30)}: ${n}`));
    console.log(`  FINANCIAL_HEALTH signals: ${financialHealthSignals.length}`);
    if (financialHealthSignals.length > 0) {
      const fhByMetric = {};
      for (const s of financialHealthSignals) fhByMetric[s.metric] = (fhByMetric[s.metric] || 0) + 1;
      Object.entries(fhByMetric).slice(0, 10).forEach(([m, n]) => console.log(`    → ${m.padEnd(28)}: ${n}`));
      if (Object.keys(fhByMetric).length > 10) console.log(`    → ... +${Object.keys(fhByMetric).length - 10} more metrics`);
    }
    console.log(`  CUSTOMER signals     : ${customerSignals.length}`);
    if (customerSignals.length > 0) {
      const custByMetric = {};
      for (const s of customerSignals) custByMetric[s.metric] = (custByMetric[s.metric] || 0) + 1;
      Object.entries(custByMetric).slice(0, 10).forEach(([m, n]) => console.log(`    → ${m.padEnd(28)}: ${n}`));
      if (Object.keys(custByMetric).length > 10) console.log(`    → ... +${Object.keys(custByMetric).length - 10} more metrics`);
    }

    if (withEndDate.length > 0) {
      console.log('\n  Trackable milestones (end_date set):');
      withEndDate.slice(0, 10).forEach(s =>
        console.log(`    ${s.metric.padEnd(22)} end=${s.end_date}  horizon=${s.time_horizon ?? 'n/a'}  value=${s.value ?? 'n/a'} ${s.unit ?? ''}`)
      );
      if (withEndDate.length > 10) console.log(`    ... +${withEndDate.length - 10} more`);
    }

    // ── Step 8: Build signal summary (DATA_BLOCK) ─────────────────────────────
    banner('Step 8 — Building signal summary (DATA_BLOCK)');
    const signalSummary = buildSignalSummary(lensConfig.name, signals, mathResult, cfgBalance, cfgPrefilter, { show_math_block: cfgShowMathBlock });
    console.log(`  Signal summary length : ${signalSummary.length} chars`);

    // ── Step 9: Equity metrics block (appended in live flow) ──────────────────
    banner('Step 9 — Equity metrics block');
    let equityBlock = '';
    try {
      const em = await fetchEquityMetrics(callId);
      equityBlock = formatEquityMetricsBlock(em);
      console.log(`  Equity block length  : ${equityBlock.length} chars`);
    } catch (err) {
      console.log(`  (equity metrics unavailable: ${err.message})`);
    }

    // ── Step 10: Build final prompt ───────────────────────────────────────────
    banner('Step 10 — Building final L2 prompt');

    const promptTemplate   = cfgPromptTemplate || L2_DEFAULT_PROMPT;
    const lensInstructions = '';   // lensComposer.js line 634: always '' regardless of branch

    const prompt = promptTemplate
      .replace('{{LENS_NAME}}',         lensConfig.name)
      .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
      .replace('{{DATA_BLOCK}}',        signalSummary + equityBlock);

    const unresolvedPlaceholders = (prompt.match(/\{\{[A-Z_]+\}\}/g) || []);
    console.log(`  Template source      : ${cfgPromptTemplate ? 'DB prompt_template' : 'L2_DEFAULT_PROMPT'}`);
    console.log(`  Final prompt length  : ${prompt.length} chars`);
    console.log(`  Estimated tokens     : ~${Math.round(prompt.length / 4)}`);
    console.log(`  Unresolved placeholders: ${unresolvedPlaceholders.length === 0 ? 'none' : unresolvedPlaceholders.join(', ')}`);
    console.log(`  Model                : ${cfgModel ?? 'anthropic/claude-haiku-4.5'}`);
    console.log(`  Max tokens           : ${cfgMaxTokens ?? 8000}`);

    // ── Step 11: Save to file ─────────────────────────────────────────────────
    banner(`Step 11 — Saving prompt to ${OUTPUT_FILE}`);
    fs.writeFileSync(OUTPUT_FILE, prompt, 'utf8');
    console.log(`  ✓ Saved to: ${OUTPUT_FILE}`);

    // ── Summary ───────────────────────────────────────────────────────────────
    banner('Summary');
    console.log(`  Ticker          : ${TICKER}`);
    console.log(`  Lens            : ${LENS_SLUG} (${lensConfig.name} v${lensConfig.version})`);
    console.log(`  Latest call     : ${callId} (${latestCall.fiscal_year} ${latestCall.quarter})`);
    console.log(`  Total signals   : ${signals.length} (current + historical, deduped)`);
    console.log(`  z_score         : ${z.toFixed(4)}`);
    console.log(`  Prompt chars    : ${prompt.length} (~${Math.round(prompt.length / 4)} tokens)`);
    console.log(`  Prompt source   : ${cfgPromptTemplate ? 'DB prompt_template' : 'L2_DEFAULT_PROMPT (fallback)'}`);
    console.log(`  Output file     : ${OUTPUT_FILE}`);

    if (signals.length === 0) {
      console.log('\n  ⚠  No signals found — DATA_BLOCK will be empty. Run L1 extraction first.');
    }

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
