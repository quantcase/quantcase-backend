'use strict';

/**
 * Export annual-report-sourced transcriptSignalV2 signals for a ticker as CSV.
 *
 * Usage:
 *   node scripts/analysis/exportL1ArSignals.js <TICKER> [output.csv]
 *   node scripts/analysis/exportL1ArSignals.js RELIANCE
 *   node scripts/analysis/exportL1ArSignals.js RELIANCE reliance_ar_signals.csv
 *
 * If no output path is given, writes to <TICKER>_ar_signals.csv in the current directory.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs   = require('fs');
const path = require('path');

const prisma = new PrismaClient();

const AR_SOURCE_CONTEXTS = [
  'chairman_letter', 'ceo_letter', 'board_report', 'mda',
  'financial_statements', 'notes_to_accounts', 'risk_section', 'governance_section',
];

function csvCell(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function flattenMeasures(measures) {
  if (!Array.isArray(measures) || measures.length === 0) return '';
  return measures
    .map(m => {
      const period = m.period
        ? `${m.period.start ?? ''}→${m.period.end ?? ''}(${m.period.type ?? ''})`
        : '';
      return [m.role, m.value_raw, m.unit, period].filter(Boolean).join(' ');
    })
    .join(' | ');
}

function flattenDetails(details) {
  if (!details || typeof details !== 'object') return '';
  return Object.entries(details)
    .filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error('Usage: node scripts/analysis/exportL1ArSignals.js <TICKER> [output.csv]');
    process.exit(1);
  }

  const upperTicker = ticker.toUpperCase();
  const outFile = process.argv[3] ?? `${upperTicker}_ar_signals.csv`;

  const signals = await prisma.transcriptSignalV2.findMany({
    where: {
      ticker:         upperTicker,
      is_invalidated: false,
      source_context: { in: AR_SOURCE_CONTEXTS },
    },
    orderBy: [{ fiscal_year: 'desc' }, { source_context: 'asc' }, { signal_type: 'asc' }],
  });

  if (signals.length === 0) {
    console.error(`No annual report signals found for ticker: ${upperTicker}`);
    process.exit(1);
  }

  const HEADER = [
    'id',
    'ticker',
    'company',
    'fiscal_year',
    'quarter',
    'call_date',
    'call_id',
    'signal_type',
    'source_context',
    'metric',
    'impact',
    'severity',
    'statement',
    'topic',
    'category',
    'measures',
    'details',
    'prompt_v',
    'extractor_model',
    'lineage_id',
    'signal_seq_id',
    'source_stmt_id',
  ];

  const rows = [HEADER.join(',')];

  for (const s of signals) {
    const d = s.data ?? {};
    rows.push(csvRow([
      s.id,
      s.ticker,
      s.company,
      s.fiscal_year,
      s.quarter,
      s.call_date,
      s.call_id,
      s.signal_type,
      s.source_context ?? d.source_context ?? '',
      s.metric         ?? d.metric         ?? '',
      s.impact         ?? d.impact         ?? '',
      s.severity       ?? d.severity       ?? '',
      s.statement      ?? d.statement      ?? '',
      d.topic          ?? '',
      d.category       ?? '',
      flattenMeasures(d.measures),
      flattenDetails(d.details),
      s.prompt_v,
      s.extractor_model,
      s.lineage_id,
      s.signal_seq_id  ?? '',
      s.source_stmt_id ?? '',
    ]));
  }

  fs.writeFileSync(outFile, rows.join('\n'), 'utf8');

  const absPath = path.resolve(outFile);
  console.log(`Exported ${signals.length} annual report signals for ${upperTicker} -> ${absPath}`);
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
