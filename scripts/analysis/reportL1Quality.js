'use strict';

/**
 * L1 signal quality report for a given ticker.
 *
 * Usage:
 *   node scripts/analysis/reportL1Quality.js <TICKER>
 *   node scripts/analysis/reportL1Quality.js RELIANCE
 *
 * Reports:
 *   - Coverage: calls found vs signals extracted
 *   - Signal distribution by type
 *   - Source context distribution
 *   - Impact / severity distribution
 *   - Null-field rates on key columns (metric, statement, measures, details)
 *   - Per-call breakdown (signal count, prompt version, call date)
 *   - Missing signal types (types with 0 signals for any call)
 *   - Thin calls (calls with fewer signals than a configurable threshold)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ALL_SIGNAL_TYPES = [
  'guidance', 'industry_signal', 'capital_allocation', 'disclosure_quality',
  'distribution_customer', 'growth_forecast', 'earnings_quality', 'kpi',
  'mgmt_tone', 'analyst_questions', 'guidance_revision', 'pricing_power',
  'competitive_position', 'milestone', 'ongoing',
];

const THIN_CALL_THRESHOLD = 30;

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
    console.error('Usage: node scripts/analysis/reportL1Quality.js <TICKER>');
    process.exit(1);
  }

  const where = { ticker: ticker.toUpperCase(), is_invalidated: false };

  // ── 1. Fetch all signals ──────────────────────────────────────────────────
  const signals = await prisma.transcriptSignalV2.findMany({
    where,
    select: {
      id: true,
      call_id: true,
      fiscal_year: true,
      quarter: true,
      call_date: true,
      signal_type: true,
      source_context: true,
      metric: true,
      impact: true,
      severity: true,
      statement: true,
      data: true,
      prompt_v: true,
      extractor_model: true,
    },
  });

  const total = signals.length;

  // ── 2. Coverage ───────────────────────────────────────────────────────────
  const callMap = {};
  for (const s of signals) {
    if (!callMap[s.call_id]) {
      callMap[s.call_id] = {
        call_id: s.call_id,
        fiscal_year: s.fiscal_year,
        quarter: s.quarter,
        call_date: s.call_date,
        prompt_v: s.prompt_v,
        model: s.extractor_model,
        count: 0,
        byType: {},
        nullMetric: 0,
        nullStatement: 0,
        noMeasures: 0,
        noDetails: 0,
      };
    }
    const c = callMap[s.call_id];
    c.count++;
    c.byType[s.signal_type] = (c.byType[s.signal_type] || 0) + 1;

    const d = s.data ?? {};
    if (!s.metric && !d.metric) c.nullMetric++;
    if (!s.statement && !d.statement) c.nullStatement++;

    const measures = d.measures;
    if (!measures || !Array.isArray(measures) || measures.length === 0) c.noMeasures++;

    const details = d.details;
    if (!details || Object.keys(details).length === 0) c.noDetails++;
  }

  const calls = Object.values(callMap).sort((a, b) => (b.call_date ?? '').localeCompare(a.call_date ?? ''));

  // ── 3. Distributions ──────────────────────────────────────────────────────
  const byType = {};
  const byContext = {};
  const byImpact = {};
  const bySeverity = {};

  for (const s of signals) {
    byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
    const ctx = s.source_context ?? (s.data?.source_context) ?? 'unknown';
    byContext[ctx] = (byContext[ctx] || 0) + 1;
    const imp = s.impact ?? (s.data?.impact) ?? 'unknown';
    byImpact[imp] = (byImpact[imp] || 0) + 1;
    const sev = s.severity ?? (s.data?.severity) ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }

  // ── 4. Null-field analysis ────────────────────────────────────────────────
  let nullMetric = 0, nullStatement = 0, noMeasures = 0, noDetails = 0;
  for (const s of signals) {
    const d = s.data ?? {};
    if (!s.metric && !d.metric) nullMetric++;
    if (!s.statement && !d.statement) nullStatement++;

    const measures = d.measures;
    if (!measures || !Array.isArray(measures) || measures.length === 0) noMeasures++;

    const details = d.details;
    if (!details || Object.keys(details).length === 0) noDetails++;
  }

  // ── 5. Missing signal types per call ──────────────────────────────────────
  const missingByCall = {};
  for (const c of calls) {
    missingByCall[c.call_id] = ALL_SIGNAL_TYPES.filter(t => !(c.byType[t] > 0));
  }

  // ── 6. Print report ───────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  L1 SIGNAL QUALITY REPORT — ${ticker.toUpperCase()}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total signals  : ${total}`);
  console.log(`  Calls covered  : ${calls.length}`);
  console.log(`  Signal types   : ${Object.keys(byType).length} / ${ALL_SIGNAL_TYPES.length} present`);

  // ── Coverage per call ─────────────────────────────────────────────────────
  header('PER-CALL COVERAGE');
  const colW = 24;
  console.log(
    `  ${'CALL ID'.padEnd(colW)} ${'FY'.padEnd(8)} ${'Q'.padEnd(4)} ${'DATE'.padEnd(12)} ${'SIGNALS'.padStart(7)}  ${'MODEL'.padEnd(30)} PROMPT VERSION`
  );
  console.log(`  ${'─'.repeat(115)}`);
  for (const c of calls) {
    const thin = c.count < THIN_CALL_THRESHOLD ? ' ⚠ THIN' : '';
    console.log(
      `  ${c.call_id.padEnd(colW)} ${(c.fiscal_year ?? '').padEnd(8)} ${(c.quarter ?? '').padEnd(4)} ${(c.call_date ?? '').padEnd(12)} ${String(c.count).padStart(7)}  ${(c.model ?? '').padEnd(30)} ${c.prompt_v ?? ''}${thin}`
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

  // ── Source context ────────────────────────────────────────────────────────
  header('SOURCE CONTEXT DISTRIBUTION');
  const ctxOrder = ['opening_remarks', 'management_presentation', 'analyst_qa', 'unknown'];
  for (const ctx of ctxOrder) {
    const n = byContext[ctx] || 0;
    if (!n) continue;
    console.log(`  ${ctx.padEnd(28)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}`);
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
  header('NULL / MISSING FIELD RATES  (across all signals)');
  const fields = [
    ['metric (null)',       nullMetric],
    ['statement (null)',    nullStatement],
    ['measures (empty)',    noMeasures],
    ['details (empty)',     noDetails],
  ];
  for (const [label, n] of fields) {
    const status = n > total * 0.5 ? '  ← HIGH' : '';
    console.log(`  ${label.padEnd(24)} ${String(n).padStart(4)} / ${total}  ${pct(n, total)}${status}`);
  }

  // ── Per-call null rates ───────────────────────────────────────────────────
  if (calls.length > 1) {
    header('NULL FIELD RATES PER CALL');
    console.log(`  ${'CALL ID'.padEnd(colW)} ${'SIGNALS'.padStart(7)}  ${'NULL metric'.padStart(11)}  ${'NULL stmt'.padStart(9)}  ${'no measures'.padStart(11)}  ${'no details'.padStart(10)}`);
    console.log(`  ${'─'.repeat(85)}`);
    for (const c of calls) {
      console.log(
        `  ${c.call_id.padEnd(colW)} ${String(c.count).padStart(7)}  ` +
        `${pct(c.nullMetric, c.count).padStart(11)}  ` +
        `${pct(c.nullStatement, c.count).padStart(9)}  ` +
        `${pct(c.noMeasures, c.count).padStart(11)}  ` +
        `${pct(c.noDetails, c.count).padStart(10)}`
      );
    }
  }

  // ── Missing types per call ────────────────────────────────────────────────
  header('MISSING SIGNAL TYPES PER CALL');
  for (const c of calls) {
    const missing = missingByCall[c.call_id];
    if (missing.length === 0) {
      console.log(`  ${c.call_id.padEnd(colW)}  ✓ all 14 types present`);
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
