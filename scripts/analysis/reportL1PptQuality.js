'use strict';

/**
 * L1 PPT signal quality report for a given ticker.
 *
 * Usage:
 *   node scripts/analysis/reportL1PptQuality.js <TICKER>
 *   node scripts/analysis/reportL1PptQuality.js RELIANCE
 *
 * Reports:
 *   - Coverage: calls with PPT signals vs total calls with ppt_url
 *   - Signal distribution by type
 *   - Source context distribution (PPT-specific contexts)
 *   - Impact / severity distribution
 *   - Null-field rates on key columns (metric, statement, measures, details)
 *   - Per-call breakdown (signal count, prompt version, call date, chunk coverage)
 *   - Missing signal types (types with 0 signals for any call)
 *   - Thin calls (calls with fewer signals than configurable threshold)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PPT_SOURCE_CONTEXTS = [
  'financial_actual', 'capex_actual', 'kpi_actual',
  'customer_concentration', 'distribution_channels',
  'product_technology', 'competitive_landscape',
  'disclosure_quality', 'industry_signals',
  'capital_allocation', 'earnings_quality', 'future_target',
];

const ALL_SIGNAL_TYPES = [
  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
  'distribution_customer', 'growth_forecast', 'earnings_quality', 'kpi',
  'competitive_position', 'milestone', 'ongoing',
];

const THIN_CALL_THRESHOLD = 20;

function pct(n, total) {
  if (!total) return '  n/a';
  return `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function bar(n, total, width = 20) {
  if (!total) return '░'.repeat(width);
  const filled = Math.round((n / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function header(title) {
  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error('Usage: node scripts/analysis/reportL1PptQuality.js <TICKER>');
    process.exit(1);
  }

  const upperTicker = ticker.toUpperCase();

  // ── 1. Fetch all PPT signals ──────────────────────────────────────────────
  const signals = await prisma.transcriptSignalV2.findMany({
    where: {
      ticker:         upperTicker,
      is_invalidated: false,
      source_context: { in: PPT_SOURCE_CONTEXTS },
    },
    select: {
      id:              true,
      call_id:         true,
      fiscal_year:     true,
      quarter:         true,
      call_date:       true,
      signal_type:     true,
      source_context:  true,
      metric:          true,
      impact:          true,
      severity:        true,
      statement:       true,
      data:            true,
      prompt_v:        true,
      extractor_model: true,
      lineage_id:      true,
    },
  });

  // ── 2. Fetch all calls with ppt_url for this ticker ───────────────────────
  const allCalls = await prisma.earnings_calls.findMany({
    where:   { company: upperTicker },
    select:  { id: true, fiscal_year: true, quarter: true, call_date: true, ppt_url: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });
  const callsWithPpt = allCalls.filter(c => c.ppt_url);

  const total = signals.length;

  // ── 3. Build per-call map ─────────────────────────────────────────────────
  const callMap = {};
  for (const s of signals) {
    if (!callMap[s.call_id]) {
      callMap[s.call_id] = {
        call_id:      s.call_id,
        fiscal_year:  s.fiscal_year,
        quarter:      s.quarter,
        call_date:    s.call_date,
        prompt_v:     s.prompt_v,
        model:        s.extractor_model,
        count:        0,
        byType:       {},
        byContext:    {},
        lineageIds:   new Set(),
        nullMetric:   0,
        nullStatement:0,
        noMeasures:   0,
        noDetails:    0,
      };
    }
    const c = callMap[s.call_id];
    c.count++;
    c.byType[s.signal_type]     = (c.byType[s.signal_type] || 0) + 1;
    c.byContext[s.source_context] = (c.byContext[s.source_context] || 0) + 1;
    if (s.lineage_id) c.lineageIds.add(s.lineage_id);

    const d = s.data ?? {};
    if (!s.metric    && !d.metric)                                         c.nullMetric++;
    if (!s.statement && !d.statement)                                      c.nullStatement++;
    const measures = d.measures;
    if (!measures || !Array.isArray(measures) || measures.length === 0)    c.noMeasures++;
    const details  = d.details;
    if (!details  || Object.keys(details).length === 0)                    c.noDetails++;
  }

  const calls = Object.values(callMap).sort((a, b) => (b.call_date ?? '').localeCompare(a.call_date ?? ''));

  // ── 4. Global distributions ───────────────────────────────────────────────
  const byType     = {};
  const byContext  = {};
  const byImpact   = {};
  const bySeverity = {};

  for (const s of signals) {
    byType[s.signal_type]     = (byType[s.signal_type]     || 0) + 1;
    byContext[s.source_context] = (byContext[s.source_context] || 0) + 1;
    const imp = s.impact   ?? s.data?.impact   ?? 'unknown';
    const sev = s.severity ?? s.data?.severity ?? 'unknown';
    byImpact[imp]   = (byImpact[imp]   || 0) + 1;
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }

  // ── 5. Global null-field counts ───────────────────────────────────────────
  let nullMetric = 0, nullStatement = 0, noMeasures = 0, noDetails = 0;
  for (const s of signals) {
    const d = s.data ?? {};
    if (!s.metric    && !d.metric)                                         nullMetric++;
    if (!s.statement && !d.statement)                                      nullStatement++;
    const measures = d.measures;
    if (!measures || !Array.isArray(measures) || measures.length === 0)    noMeasures++;
    const details  = d.details;
    if (!details  || Object.keys(details).length === 0)                    noDetails++;
  }

  // ── 6. Print report ───────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  L1 PPT SIGNAL QUALITY REPORT — ${upperTicker}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total PPT signals : ${total}`);
  console.log(`  Calls with signals: ${calls.length} of ${callsWithPpt.length} calls that have a PPT URL`);
  console.log(`  Signal types      : ${Object.keys(byType).length} / ${ALL_SIGNAL_TYPES.length} present`);
  console.log(`  Source contexts   : ${Object.keys(byContext).length} / ${PPT_SOURCE_CONTEXTS.length} present`);

  // ── PPT coverage gap ──────────────────────────────────────────────────────
  const signalCallIds = new Set(calls.map(c => c.call_id));
  const uncovered = callsWithPpt.filter(c => !signalCallIds.has(c.id));
  if (uncovered.length > 0) {
    header('CALLS WITH PPT URL BUT NO SIGNALS  (not yet processed)');
    for (const c of uncovered) {
      console.log(`  ${c.id.padEnd(40)} ${(c.fiscal_year ?? '').padEnd(8)} ${(c.quarter ?? '').padEnd(4)} ${c.call_date ?? ''}`);
    }
  }

  // ── Per-call coverage ─────────────────────────────────────────────────────
  header('PER-CALL COVERAGE');
  const colW = 40;
  console.log(
    `  ${'CALL ID'.padEnd(colW)} ${'FY'.padEnd(8)} ${'Q'.padEnd(4)} ${'DATE'.padEnd(12)} ${'SIG'.padStart(4)}  ${'CHUNKS'.padStart(6)}  ${'MODEL'.padEnd(28)} PROMPT VER`
  );
  console.log(`  ${'─'.repeat(125)}`);
  for (const c of calls) {
    const thin = c.count < THIN_CALL_THRESHOLD ? ' ⚠ THIN' : '';
    console.log(
      `  ${c.call_id.padEnd(colW)} ` +
      `${(c.fiscal_year ?? '').padEnd(8)} ` +
      `${(c.quarter    ?? '').padEnd(4)} ` +
      `${(c.call_date  ?? '').padEnd(12)} ` +
      `${String(c.count).padStart(4)}  ` +
      `${String(c.lineageIds.size).padStart(6)}  ` +
      `${(c.model ?? '').padEnd(28)} ` +
      `${c.prompt_v ?? ''}${thin}`
    );
  }

  // ── Signal type distribution ──────────────────────────────────────────────
  header('SIGNAL TYPE DISTRIBUTION');
  const sortedTypes = ALL_SIGNAL_TYPES.slice().sort((a, b) => (byType[b] || 0) - (byType[a] || 0));
  for (const t of sortedTypes) {
    const n = byType[t] || 0;
    const absent = n === 0 ? '  ← MISSING' : '';
    console.log(`  ${t.padEnd(24)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}${absent}`);
  }
  // also show any unexpected types not in the known list
  for (const [t, n] of Object.entries(byType)) {
    if (!ALL_SIGNAL_TYPES.includes(t)) {
      console.log(`  ${t.padEnd(24)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}  ← UNEXPECTED`);
    }
  }

  // ── Source context distribution (PPT-specific) ────────────────────────────
  header('SOURCE CONTEXT DISTRIBUTION  (PPT contexts)');
  const sortedCtx = PPT_SOURCE_CONTEXTS.slice().sort((a, b) => (byContext[b] || 0) - (byContext[a] || 0));
  for (const ctx of sortedCtx) {
    const n = byContext[ctx] || 0;
    const absent = n === 0 ? '  ← MISSING' : '';
    console.log(`  ${ctx.padEnd(28)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}${absent}`);
  }

  // ── Impact distribution ───────────────────────────────────────────────────
  header('IMPACT DISTRIBUTION');
  for (const imp of ['high', 'medium', 'low', 'unknown']) {
    const n = byImpact[imp] || 0;
    if (!n) continue;
    console.log(`  ${imp.padEnd(12)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}`);
  }

  // ── Severity distribution ─────────────────────────────────────────────────
  header('SEVERITY DISTRIBUTION');
  for (const sev of ['critical', 'high', 'medium', 'low', 'informational', 'unknown']) {
    const n = bySeverity[sev] || 0;
    if (!n) continue;
    console.log(`  ${sev.padEnd(16)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}`);
  }

  // ── Null-field rates ──────────────────────────────────────────────────────
  header('NULL / MISSING FIELD RATES  (across all PPT signals)');
  const fields = [
    ['metric (null)',    nullMetric],
    ['statement (null)', nullStatement],
    ['measures (empty)', noMeasures],
    ['details (empty)',  noDetails],
  ];
  for (const [label, n] of fields) {
    const status = n > total * 0.5 ? '  ← HIGH' : '';
    console.log(`  ${label.padEnd(24)} ${String(n).padStart(4)} / ${total}  ${pct(n, total)}${status}`);
  }

  // ── Per-call null rates ───────────────────────────────────────────────────
  if (calls.length > 1) {
    header('NULL FIELD RATES PER CALL');
    console.log(
      `  ${'CALL ID'.padEnd(colW)} ${'SIG'.padStart(4)}  ${'NULL metric'.padStart(11)}  ` +
      `${'NULL stmt'.padStart(9)}  ${'no measures'.padStart(11)}  ${'no details'.padStart(10)}`
    );
    console.log(`  ${'─'.repeat(95)}`);
    for (const c of calls) {
      console.log(
        `  ${c.call_id.padEnd(colW)} ${String(c.count).padStart(4)}  ` +
        `${pct(c.nullMetric,    c.count).padStart(11)}  ` +
        `${pct(c.nullStatement, c.count).padStart(9)}  ` +
        `${pct(c.noMeasures,    c.count).padStart(11)}  ` +
        `${pct(c.noDetails,     c.count).padStart(10)}`
      );
    }
  }

  // ── Source context breakdown per call ─────────────────────────────────────
  if (calls.length > 0) {
    header('SOURCE CONTEXT BREAKDOWN PER CALL');
    const ctxCols = PPT_SOURCE_CONTEXTS;
    const labelW  = 40;
    const colPad  = 6;
    console.log(
      `  ${'CALL ID'.padEnd(labelW)} ` +
      ctxCols.map(c => c.slice(0, colPad).padStart(colPad)).join(' ')
    );
    console.log(`  ${'─'.repeat(labelW + 2 + ctxCols.length * (colPad + 1))}`);
    for (const c of calls) {
      const row = ctxCols.map(ctx => String(c.byContext[ctx] || 0).padStart(colPad)).join(' ');
      console.log(`  ${c.call_id.padEnd(labelW)} ${row}`);
    }
    console.log(`\n  Columns: ${ctxCols.join(', ')}`);
  }

  // ── Missing signal types per call ─────────────────────────────────────────
  header('MISSING SIGNAL TYPES PER CALL');
  for (const c of calls) {
    const missing = ALL_SIGNAL_TYPES.filter(t => !(c.byType[t] > 0));
    if (missing.length === 0) {
      console.log(`  ${c.call_id.padEnd(colW)}  ✓ all types present`);
    } else {
      console.log(`  ${c.call_id.padEnd(colW)}  missing (${missing.length}): ${missing.join(', ')}`);
    }
  }

  // ── Thin calls ────────────────────────────────────────────────────────────
  const thinCalls = calls.filter(c => c.count < THIN_CALL_THRESHOLD);
  if (thinCalls.length > 0) {
    header(`THIN CALLS  (< ${THIN_CALL_THRESHOLD} signals)`);
    for (const c of thinCalls) {
      console.log(`  ${c.call_id.padEnd(colW)}  ${c.count} signals`);
    }
  }

  console.log(`\n${'═'.repeat(70)}\n`);
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
