#!/usr/bin/env node
'use strict';

/**
 * Debug: build the guidance-credibility (guidance record) L2 prompt for any ticker and save it to a file.
 * No LLM call is made.
 *
 * Usage:
 *   node scripts/debug_guidance_record_prompt.js MSUMI
 *   node scripts/debug_guidance_record_prompt.js MSUMI /tmp/my_output.txt
 */

require('dotenv').config();
const fs               = require('fs');
const path             = require('path');
const { PrismaClient } = require('@prisma/client');

const TICKER      = process.argv[2] || 'MSUMI';
const OUTPUT_FILE = process.argv[3] || `/tmp/guidance_record_prompt_${TICKER}.txt`;

// ─── Inlined from lensComposer (not exported) ─────────────────────────────────

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
  const stdDev = Math.sqrt(variance);
  return { lo: -stdDev, hi: stdDev };
}

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

const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };

function buildSignalSummary(lensName, signals, mathResult, balance) {
  const lines = [
    `LENS: ${lensName}`,
    `SIGNAL SUMMARY (${signals.length} signals, weighted aggregate z=${mathResult.z_score.toFixed(4)}):`,
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
    const stmt       = s.statement ? ` — "${s.statement}"` : '';
    return `  [id=${s.id}] ${s.metric}: ${s.value}${s.unit ? ' ' + s.unit : ''}${periodStr}${datesStr} (${s.signal_type}${periodType}${impact})${stmt}`;
  };

  for (const [type, groupSignals] of groups) {
    const cap = balance?.[type] ?? balance?.default ?? 15;

    // For milestone signals: include all (even null-value) so the LLM sees guidance text.
    // Sort: concrete values (value != null) first, then null-value signals; within each group by impact.
    // For other signal types: keep existing behaviour (value != null filter, sort by impact then end_date).
    let sorted;
    if (type === 'milestone') {
      sorted = [...groupSignals].sort((a, b) => {
        const aHasVal = a.value != null ? 0 : 1;
        const bHasVal = b.value != null ? 0 : 1;
        if (aHasVal !== bHasVal) return aHasVal - bHasVal;
        const ia = IMPACT_ORDER[a.impact] ?? 3;
        const ib = IMPACT_ORDER[b.impact] ?? 3;
        return ia - ib;
      });
    } else {
      sorted = groupSignals
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

  lines.push('');
  lines.push(`MATH: z=${mathResult.z_score.toFixed(4)}, CI=[${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}], n=${signals.filter(s => s.value != null).length}`);
  return lines.join('\n');
}

// ─── L2 default prompt (copied from lensComposer) ────────────────────────────

const L2_DEFAULT_PROMPT = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.
{{LENS_INSTRUCTIONS}}
{{DATA_BLOCK}}

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the key finding (e.g. "Margins expanding on operating leverage; FCF conversion risk remains — watch CFO/PAT ratio.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "EBITDA margin up 180 bps YoY on cost discipline.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Debt elevated; interest cover below 3x for 2 quarters.")
- "label" in top_signals: 2–5 words, title-case, human-readable (e.g. "Operating Cash Flow")
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, action-oriented synthesis leading with the key finding>,
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

// ─── Guidance-credibility lens config (from seedLensConfigs) ─────────────────

const GUIDANCE_CREDIBILITY_CONFIG = {
  signal_filters: {
    signal_types:       ['milestone', 'governance'],
    metric_family:      ['milestone', 'governance'],
    include_historical: true,
  },
  weights: [
    { metric: 'guidance_given',       w: 0.5  },
    { metric: 'guidance_missed',      w: -0.8 },
    { metric: 'proactive_disclosure', w:  0.3 },
  ],
  aggregation:     'weighted_sum',
  balance:         { milestone: 20, default: 12 },
  // NOTE: lensConfig.config.lens_instructions is not set → falls back to ''
  lens_instructions: '',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function banner(title) {
  const line = '═'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();

  try {
    // ── Step 1: Find latest call for MSUMI ───────────────────────────────────
    banner(`Step 1 — Latest earnings call for ${TICKER}`);

    const latestCall = await prisma.earnings_calls.findFirst({
      where: {
        company: TICKER,
        OR: [
          { transcript_text: { not: null }, NOT: { transcript_text: '' } },
          { ppt_text:        { not: null }, NOT: { ppt_text:        '' } },
        ],
      },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });

    if (!latestCall) {
      console.error(`  ✗ No earnings call with text found for ticker "${TICKER}"`);
      process.exit(1);
    }

    const callId = latestCall.id;
    console.log(`  ✓ callId   : ${callId}`);
    console.log(`  ✓ company  : ${latestCall.company_name ?? TICKER}`);
    console.log(`  ✓ period   : ${latestCall.fiscal_year} ${latestCall.quarter}`);
    console.log(`  ✓ callDate : ${latestCall.call_date}`);

    // ── Step 2: Query current signals ────────────────────────────────────────
    banner(`Step 2 — Current call signals (milestone + governance)`);

    const filters = GUIDANCE_CREDIBILITY_CONFIG.signal_filters;
    const currentSignals = await prisma.extractedSignal.findMany({
      where: {
        call_id:       callId,
        signal_type:   { in: filters.signal_types },
        metric_family: { in: filters.metric_family },
        is_invalidated: false,
      },
      orderBy: [{ call_date: 'desc' }, { created_at: 'desc' }],
    });

    console.log(`  Current call signals found: ${currentSignals.length}`);
    const byType = {};
    for (const s of currentSignals) {
      byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
    }
    Object.entries(byType).forEach(([t, n]) => console.log(`    ${t.padEnd(20)} : ${n}`));

    if (currentSignals.length === 0) {
      console.log(`  ⚠️  No signals found for callId "${callId}". The prompt will be empty.`);
      console.log(`     Have you run the L1 summarization job for this call?`);
    }

    // ── Step 3: Historical signals (include_historical) ───────────────────────
    banner(`Step 3 — Historical signals for ${TICKER} (excl. current call)`);

    let signals = currentSignals;
    if (filters.include_historical && currentSignals.length > 0) {
      const historicalSignals = await prisma.extractedSignal.findMany({
        where: {
          ticker:        TICKER,
          call_id:       { not: callId },
          signal_type:   { in: filters.signal_types },
          metric_family: { in: filters.metric_family },
          is_invalidated: false,
        },
        orderBy: [{ call_date: 'desc' }, { created_at: 'desc' }],
      });
      console.log(`  Historical signals found: ${historicalSignals.length}`);
      if (historicalSignals.length > 0) {
        const histCalls = [...new Set(historicalSignals.map(s => `${s.call_id} (${s.fiscal_year} ${s.quarter ?? ''})`))];
        console.log(`  Historical calls: ${histCalls.slice(0, 5).join(', ')}${histCalls.length > 5 ? ` … +${histCalls.length - 5} more` : ''}`);
        signals = [...currentSignals, ...historicalSignals];
      }
    } else {
      console.log('  (include_historical=false or no current signals — skipped)');
    }

    // ── Step 4: Deduplicate ──────────────────────────────────────────────────
    banner('Step 4 — Deduplication (prowess > qe > transcript)');
    const deduped = deduplicateSignals(signals);
    console.log(`  Before: ${signals.length}  →  After: ${deduped.length}  (dropped: ${signals.length - deduped.length})`);
    signals = deduped;

    // ── Step 5: Math step ────────────────────────────────────────────────────
    banner('Step 5 — Math (weighted sum)');

    const weights = GUIDANCE_CREDIBILITY_CONFIG.weights;
    const weightMap = new Map(weights.map(o => [o.metric, { w: o.w ?? 1.0, b: o.b ?? 0.0 }]));
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
      snapshot.push({ metric: sig.metric, value: sig.value, normalized, w: override.w, contribution });
    }

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

    // ── Step 6: Key guidance-related signal counts ───────────────────────────
    banner('Step 6 — Guidance record signal analysis');

    const milestoneSignals  = signals.filter(s => s.signal_type === 'milestone');
    const governanceSignals = signals.filter(s => s.signal_type === 'governance');
    const withEndDate       = milestoneSignals.filter(s => s.end_date != null);
    const withoutEndDate    = milestoneSignals.filter(s => s.end_date == null);
    const guidanceGiven     = governanceSignals.filter(s => s.metric === 'guidance_given');
    const guidanceMissed    = governanceSignals.filter(s => s.metric === 'guidance_missed');
    const proactiveDisc     = governanceSignals.filter(s => s.metric === 'proactive_disclosure');
    const futureGoals       = milestoneSignals.filter(s => s.milestone_category === 'future_goal');
    const successDisc       = milestoneSignals.filter(s => s.milestone_category === 'success_disclosure');
    const failureDisc       = milestoneSignals.filter(s => s.milestone_category === 'failure_disclosure');

    console.log(`  MILESTONE signals    : ${milestoneSignals.length}`);
    console.log(`    → with end_date    : ${withEndDate.length}  (trackable as guidance record)`);
    console.log(`    → no end_date      : ${withoutEndDate.length}  (qualitative only)`);
    console.log(`    → future_goal      : ${futureGoals.length}`);
    console.log(`    → success_disc.    : ${successDisc.length}`);
    console.log(`    → failure_disc.    : ${failureDisc.length}`);
    console.log(`  GOVERNANCE signals   : ${governanceSignals.length}`);
    console.log(`    → guidance_given   : ${guidanceGiven.length}`);
    console.log(`    → guidance_missed  : ${guidanceMissed.length}`);
    console.log(`    → proactive_discl. : ${proactiveDisc.length}`);

    if (withEndDate.length > 0) {
      console.log('\n  Trackable milestones (with end_date):');
      withEndDate.slice(0, 10).forEach(s =>
        console.log(`    [${s.milestone_category ?? 'n/a'}] ${s.metric.padEnd(20)} end=${s.end_date}  value=${s.value ?? 'n/a'} ${s.unit ?? ''}`)
      );
      if (withEndDate.length > 10) console.log(`    ... +${withEndDate.length - 10} more`);
    }

    // ── Step 7: Build signal summary ─────────────────────────────────────────
    banner('Step 7 — Building signal summary (DATA_BLOCK)');
    const signalSummary = buildSignalSummary('Guidance Credibility', signals, mathResult, GUIDANCE_CREDIBILITY_CONFIG.balance);
    console.log(`  Signal summary length : ${signalSummary.length} chars`);

    // ── Step 8: Build full L2 prompt ─────────────────────────────────────────
    banner('Step 8 — Building full L2 prompt');

    // NOTE: lensComposer.js line 260 has a bug — it references `lensInstructions`
    // which is never declared in scope. This script fixes it by using
    // lensConfig.config.lens_instructions ?? '' (which is '' for guidance-credibility).
    const lensInstructions = GUIDANCE_CREDIBILITY_CONFIG.lens_instructions;

    const prompt = L2_DEFAULT_PROMPT
      .replace('{{LENS_NAME}}',         'Guidance Credibility')
      .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
      .replace('{{DATA_BLOCK}}',        signalSummary);

    console.log(`  Final prompt length  : ${prompt.length} chars`);
    console.log(`  Estimated tokens     : ~${Math.round(prompt.length / 4)}`);

    // Prompt sections check
    console.log('\n  Prompt section check:');
    console.log(`    Has {{LENS_NAME}} placeholder resolved   : ${!prompt.includes('{{LENS_NAME}}')}`);
    console.log(`    Has {{LENS_INSTRUCTIONS}} resolved       : ${!prompt.includes('{{LENS_INSTRUCTIONS}}')}`);
    console.log(`    Has {{DATA_BLOCK}} resolved              : ${!prompt.includes('{{DATA_BLOCK}}')}`);
    console.log(`    Contains SIGNAL SUMMARY                  : ${prompt.includes('SIGNAL SUMMARY')}`);
    console.log(`    Contains MATH line                       : ${prompt.includes('MATH: z=')}`);
    console.log(`    Contains guided_value field definition   : ${prompt.includes('"guided_value"')}`);
    console.log(`    Contains guided_date field definition    : ${prompt.includes('"guided_date"')}`);
    console.log(`    Contains direction field definition      : ${prompt.includes('"direction"')}`);

    // ── Step 9: Save to file ─────────────────────────────────────────────────
    banner(`Step 9 — Saving prompt to ${OUTPUT_FILE}`);
    fs.writeFileSync(OUTPUT_FILE, prompt, 'utf8');
    console.log(`  ✓ Saved to: ${OUTPUT_FILE}`);

    // ── Step 10: Summary ─────────────────────────────────────────────────────
    banner('Summary');
    console.log(`  Ticker          : ${TICKER}`);
    console.log(`  Latest call     : ${callId} (${latestCall.fiscal_year} ${latestCall.quarter})`);
    console.log(`  Total signals   : ${signals.length} (current + historical, deduped)`);
    console.log(`    milestone      : ${milestoneSignals.length}`);
    console.log(`    governance     : ${governanceSignals.length}`);
    console.log(`  z_score         : ${z.toFixed(4)}`);
    console.log(`  Prompt length   : ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
    console.log(`  Output file     : ${OUTPUT_FILE}`);

    // Warnings
    if (signals.length === 0) {
      console.log('\n  ⚠️  WARNING: No signals found — the L2 prompt data block will be empty.');
      console.log('     Run the L1 summarization job first: POST /api/calls/:callId/summarize');
    }
    if (guidanceMissed.length > 0) {
      console.log(`\n  ⚠️  ${guidanceMissed.length} guidance_missed signal(s) detected — management credibility concern.`);
    }
    if (guidanceGiven.length === 0 && milestoneSignals.length === 0) {
      console.log('\n  ⚠️  No guidance signals found — this may score poorly on guidance-credibility lens.');
    }

    // Bug note
    console.log('\n  ── Bug note ──────────────────────────────────────────────────────────');
    console.log('  lensComposer.js:260 references `lensInstructions` which is never declared');
    console.log('  in scope. This will throw a ReferenceError at runtime when the lens is');
    console.log('  computed (since the DB prompt_template for guidance-credibility is null,');
    console.log('  triggering the code path that uses L2_DEFAULT_PROMPT with the replace call).');
    console.log('  Fix: declare `const lensInstructions = lensConfig.config.lens_instructions ?? \'\';`');
    console.log('  before the .replace() calls (around line 255 in lensComposer.js).');

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
