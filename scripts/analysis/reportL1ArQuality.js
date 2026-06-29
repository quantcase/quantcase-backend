'use strict';

/**
 * L1 annual report signal quality report for a given ticker.
 *
 * Usage:
 *   node scripts/analysis/reportL1ArQuality.js <TICKER>
 *   node scripts/analysis/reportL1ArQuality.js RELIANCE
 *
 * Reports:
 *   - Coverage: annual reports with signals vs total reports with annual_report_url
 *   - Signal distribution by type
 *   - Source context distribution (AR-specific section slugs)
 *   - Impact / severity distribution
 *   - Null-field rates on key columns (metric, statement, measures, details)
 *   - Per-report breakdown (signal count, prompt version, fiscal year, chunk coverage)
 *   - Missing signal types (types with 0 signals for any report)
 *   - Thin reports (reports with fewer signals than configurable threshold)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const AR_SOURCE_CONTEXTS = [
  'chairman_letter', 'ceo_letter', 'board_report', 'mda',
  'financial_statements', 'notes_to_accounts', 'risk_section', 'governance_section',
];

const ALL_SIGNAL_TYPES = [
  'financial_figure', 'guidance', 'growth_forecast', 'capital_allocation',
  'risk_factor', 'contingent_liability', 'governance_signal', 'strategic_claim',
  'm_and_a', 'kpi', 'leadership_statement', 'milestone', 'ongoing',
  'industry_signal', 'disclosure_quality', 'earnings_quality', 'guidance_revision',
];

const THIN_REPORT_THRESHOLD = 30;

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
    console.error('Usage: node scripts/analysis/reportL1ArQuality.js <TICKER>');
    process.exit(1);
  }

  const upperTicker = ticker.toUpperCase();

  // ── 1. Fetch all AR signals ───────────────────────────────────────────────
  const signals = await prisma.transcriptSignalV2.findMany({
    where: {
      ticker:         upperTicker,
      is_invalidated: false,
      source_context: { in: AR_SOURCE_CONTEXTS },
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

  // ── 2. Fetch all annual reports with annual_report_url for this ticker ────
  const allReports = await prisma.annual_reports.findMany({
    where:   { company: upperTicker },
    select:  { id: true, fiscal_year: true, call_date: true, annual_report_url: true },
    orderBy: [{ fiscal_year: 'desc' }],
  });
  const reportsWithUrl = allReports.filter(r => r.annual_report_url);

  const total = signals.length;

  // ── 3. Build per-report map ───────────────────────────────────────────────
  const reportMap = {};
  for (const s of signals) {
    if (!reportMap[s.call_id]) {
      reportMap[s.call_id] = {
        call_id:       s.call_id,
        fiscal_year:   s.fiscal_year,
        call_date:     s.call_date,
        prompt_v:      s.prompt_v,
        model:         s.extractor_model,
        count:         0,
        byType:        {},
        byContext:     {},
        lineageIds:    new Set(),
        nullMetric:    0,
        nullStatement: 0,
        noMeasures:    0,
        noDetails:     0,
      };
    }
    const r = reportMap[s.call_id];
    r.count++;
    r.byType[s.signal_type]       = (r.byType[s.signal_type] || 0) + 1;
    r.byContext[s.source_context] = (r.byContext[s.source_context] || 0) + 1;
    if (s.lineage_id) r.lineageIds.add(s.lineage_id);

    const d = s.data ?? {};
    if (!s.metric    && !d.metric)                                         r.nullMetric++;
    if (!s.statement && !d.statement)                                      r.nullStatement++;
    const measures = d.measures;
    if (!measures || !Array.isArray(measures) || measures.length === 0)    r.noMeasures++;
    const details  = d.details;
    if (!details  || Object.keys(details).length === 0)                    r.noDetails++;
  }

  const reports = Object.values(reportMap).sort((a, b) => (b.fiscal_year ?? '').localeCompare(a.fiscal_year ?? ''));

  // ── 4. Global distributions ───────────────────────────────────────────────
  const byType     = {};
  const byContext  = {};
  const byImpact   = {};
  const bySeverity = {};

  for (const s of signals) {
    byType[s.signal_type]       = (byType[s.signal_type]       || 0) + 1;
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
  console.log(`  L1 ANNUAL REPORT SIGNAL QUALITY REPORT — ${upperTicker}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total AR signals      : ${total}`);
  console.log(`  Reports with signals  : ${reports.length} of ${reportsWithUrl.length} reports that have a URL`);
  console.log(`  Signal types present  : ${Object.keys(byType).length} / ${ALL_SIGNAL_TYPES.length}`);
  console.log(`  Source contexts present: ${Object.keys(byContext).length} / ${AR_SOURCE_CONTEXTS.length}`);

  // ── AR coverage gap ───────────────────────────────────────────────────────
  const signalReportIds = new Set(reports.map(r => r.call_id));
  const uncovered = reportsWithUrl.filter(r => !signalReportIds.has(r.id.toString()));
  if (uncovered.length > 0) {
    header('REPORTS WITH URL BUT NO SIGNALS  (not yet processed)');
    for (const r of uncovered) {
      console.log(`  ${r.id.toString().padEnd(12)} ${(r.fiscal_year ?? '').padEnd(14)} ${r.call_date ?? ''}`);
    }
  }

  // ── Per-report coverage ───────────────────────────────────────────────────
  header('PER-REPORT COVERAGE');
  console.log(
    `  ${'REPORT ID'.padEnd(14)} ${'FY'.padEnd(14)} ${'CALL DATE'.padEnd(12)} ${'SIG'.padStart(4)}  ${'CHUNKS'.padStart(6)}  ${'MODEL'.padEnd(28)} PROMPT VER`
  );
  console.log(`  ${'─'.repeat(110)}`);
  for (const r of reports) {
    const thin = r.count < THIN_REPORT_THRESHOLD ? ' THIN' : '';
    console.log(
      `  ${r.call_id.padEnd(14)} ` +
      `${(r.fiscal_year ?? '').padEnd(14)} ` +
      `${(r.call_date   ?? '').padEnd(12)} ` +
      `${String(r.count).padStart(4)}  ` +
      `${String(r.lineageIds.size).padStart(6)}  ` +
      `${(r.model ?? '').padEnd(28)} ` +
      `${r.prompt_v ?? ''}${thin}`
    );
  }

  // ── Signal type distribution ──────────────────────────────────────────────
  header('SIGNAL TYPE DISTRIBUTION');
  const sortedTypes = ALL_SIGNAL_TYPES.slice().sort((a, b) => (byType[b] || 0) - (byType[a] || 0));
  for (const t of sortedTypes) {
    const n = byType[t] || 0;
    const absent = n === 0 ? '  <- MISSING' : '';
    console.log(`  ${t.padEnd(26)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}${absent}`);
  }
  for (const [t, n] of Object.entries(byType)) {
    if (!ALL_SIGNAL_TYPES.includes(t)) {
      console.log(`  ${t.padEnd(26)} ${String(n).padStart(4)}  ${bar(n, total)}  ${pct(n, total)}  <- UNEXPECTED`);
    }
  }

  // ── Source context distribution (AR-specific) ─────────────────────────────
  header('SOURCE CONTEXT DISTRIBUTION  (AR section slugs)');
  const sortedCtx = AR_SOURCE_CONTEXTS.slice().sort((a, b) => (byContext[b] || 0) - (byContext[a] || 0));
  for (const ctx of sortedCtx) {
    const n = byContext[ctx] || 0;
    const absent = n === 0 ? '  <- MISSING' : '';
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
  header('NULL / MISSING FIELD RATES  (across all AR signals)');
  const fields = [
    ['metric (null)',    nullMetric],
    ['statement (null)', nullStatement],
    ['measures (empty)', noMeasures],
    ['details (empty)',  noDetails],
  ];
  for (const [label, n] of fields) {
    const status = n > total * 0.5 ? '  <- HIGH' : '';
    console.log(`  ${label.padEnd(24)} ${String(n).padStart(4)} / ${total}  ${pct(n, total)}${status}`);
  }

  // ── Per-report null rates ─────────────────────────────────────────────────
  if (reports.length > 1) {
    header('NULL FIELD RATES PER REPORT');
    console.log(
      `  ${'REPORT ID'.padEnd(14)} ${'SIG'.padStart(4)}  ${'NULL metric'.padStart(11)}  ` +
      `${'NULL stmt'.padStart(9)}  ${'no measures'.padStart(11)}  ${'no details'.padStart(10)}`
    );
    console.log(`  ${'─'.repeat(80)}`);
    for (const r of reports) {
      console.log(
        `  ${r.call_id.padEnd(14)} ${String(r.count).padStart(4)}  ` +
        `${pct(r.nullMetric,    r.count).padStart(11)}  ` +
        `${pct(r.nullStatement, r.count).padStart(9)}  ` +
        `${pct(r.noMeasures,    r.count).padStart(11)}  ` +
        `${pct(r.noDetails,     r.count).padStart(10)}`
      );
    }
  }

  // ── Source context breakdown per report ───────────────────────────────────
  if (reports.length > 0) {
    header('SOURCE CONTEXT BREAKDOWN PER REPORT');
    const ctxCols = AR_SOURCE_CONTEXTS;
    const labelW  = 14;
    const colPad  = 6;
    console.log(
      `  ${'REPORT ID'.padEnd(labelW)} ` +
      ctxCols.map(c => c.slice(0, colPad).padStart(colPad)).join(' ')
    );
    console.log(`  ${'─'.repeat(labelW + 2 + ctxCols.length * (colPad + 1))}`);
    for (const r of reports) {
      const row = ctxCols.map(ctx => String(r.byContext[ctx] || 0).padStart(colPad)).join(' ');
      console.log(`  ${r.call_id.padEnd(labelW)} ${row}`);
    }
    console.log(`\n  Columns: ${ctxCols.join(', ')}`);
  }

  // ── Missing signal types per report ──────────────────────────────────────
  header('MISSING SIGNAL TYPES PER REPORT');
  const labelW = 14;
  for (const r of reports) {
    const missing = ALL_SIGNAL_TYPES.filter(t => !(r.byType[t] > 0));
    const label   = `${r.call_id.padEnd(labelW)} ${(r.fiscal_year ?? '').padEnd(14)}`;
    if (missing.length === 0) {
      console.log(`  ${label}  all types present`);
    } else {
      console.log(`  ${label}  missing (${missing.length}): ${missing.join(', ')}`);
    }
  }

  // ── Thin reports ──────────────────────────────────────────────────────────
  const thinReports = reports.filter(r => r.count < THIN_REPORT_THRESHOLD);
  if (thinReports.length > 0) {
    header(`THIN REPORTS  (< ${THIN_REPORT_THRESHOLD} signals)`);
    for (const r of thinReports) {
      console.log(`  ${r.call_id.padEnd(14)} ${(r.fiscal_year ?? '').padEnd(14)}  ${r.count} signals`);
    }
  }

  console.log(`\n${'═'.repeat(70)}\n`);
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
