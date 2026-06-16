'use strict';

/**
 * Export L2 lens_data for a ticker as a multi-sheet CSV.
 * Produces three sections separated by blank lines:
 *   1. SUMMARY  — one row per lens (score, status, takeaway, z_score, highlights, risks, key_metrics)
 *   2. TOP_SIGNALS — one row per signal across all lenses
 *   3. PATTERNS — one row per pattern across all lenses (guidance-credibility and any future bridge-prompt lenses)
 *
 * Usage:
 *   node scripts/analysis/exportL2LensData.js <TICKER> [output.csv]
 *   node scripts/analysis/exportL2LensData.js RELIANCE
 *   node scripts/analysis/exportL2LensData.js HDFCBANK hdfcbank_lens.csv
 *   node scripts/analysis/exportL2LensData.js RELIANCE --lens guidance-credibility
 *
 * Flags:
 *   --lens <slug>   Restrict to a single lens slug
 *   --all-calls     Export all non-stale call_ids for the ticker, not just the latest
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs   = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function csvCell(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) { return cells.map(csvCell).join(','); }

function sectionHeader(title) {
  return `\n## ${title}\n`;
}

// ─── Flatteners ──────────────────────────────────────────────────────────────

const SUMMARY_HEADER = [
  'ticker', 'call_id', 'fiscal_year', 'quarter', 'computed_at',
  'lens_slug', 'lens_config_v', 'z_score', 'signal_count',
  'score', 'status', 'takeaway',
  'highlights', 'risks',
  'key_metrics',
];

function flattenSummary(score, ld) {
  const ld_      = ld ?? {};
  const highlights = Array.isArray(ld_.highlights) ? ld_.highlights.join(' | ') : '';
  const risks      = Array.isArray(ld_.risks)      ? ld_.risks.join(' | ')      : '';
  const keyMetrics = ld_.key_metrics && typeof ld_.key_metrics === 'object'
    ? Object.entries(ld_.key_metrics).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';
  return csvRow([
    score.ticker,
    score.call_id,
    score.fiscal_year ?? '',
    score.quarter     ?? '',
    score.computed_at ? new Date(score.computed_at).toISOString() : '',
    score.lens_slug,
    score.lens_config_v,
    score.z_score,
    score.signal_count,
    ld_.score    ?? '',
    ld_.status   ?? '',
    ld_.takeaway ?? '',
    highlights,
    risks,
    keyMetrics,
  ]);
}

const TOP_SIGNALS_HEADER = [
  'ticker', 'call_id', 'lens_slug',
  'signal_id', 'metric', 'label',
  'announcement_date', 'value_at_announcement',
  'value_targeted', 'guided_value', 'guided_date',
  'target_date',
  'actual_value', 'actual_date',
  'unit', 'delta', 'delta_pct',
  'direction', 'impact',
  'statement', 'original_statement',
];

function flattenTopSignal(score, sig) {
  return csvRow([
    score.ticker,
    score.call_id,
    score.lens_slug,
    sig.signal_id          ?? '',
    sig.metric             ?? '',
    sig.label              ?? '',
    sig.announcement_date  ?? '',
    sig.value_at_announcement ?? '',
    sig.value_targeted     ?? '',
    sig.guided_value       ?? '',
    sig.guided_date        ?? '',
    sig.target_date        ?? '',
    sig.actual_value       ?? '',
    sig.actual_date        ?? '',
    sig.unit               ?? '',
    sig.delta              ?? '',
    sig.delta_pct          ?? '',
    sig.direction          ?? '',
    sig.impact             ?? '',
    sig.statement          ?? '',
    sig.original_statement ?? '',
  ]);
}

const PATTERNS_HEADER = [
  'ticker', 'call_id', 'lens_slug',
  'type', 'confidence', 'confidence_reason',
  'label', 'sentence',
  'direction', 'impact',
  'shape_label', 'shape_data',
  'evidence_count', 'evidence_summary',
];

function flattenPattern(score, pat) {
  const evidenceSummary = Array.isArray(pat.evidence)
    ? pat.evidence.map(e => [e.period, e.value != null ? `val=${e.value}` : '', e.quote ? `"${e.quote.slice(0, 60)}"` : ''].filter(Boolean).join(' ')).join(' | ')
    : '';
  return csvRow([
    score.ticker,
    score.call_id,
    score.lens_slug,
    pat.type             ?? '',
    pat.confidence       ?? '',
    pat.confidence_reason ?? '',
    pat.label            ?? '',
    pat.sentence         ?? '',
    pat.direction        ?? '',
    pat.impact           ?? '',
    pat.shape_label      ?? '',
    pat.shape_data       ?? '',
    Array.isArray(pat.evidence) ? pat.evidence.length : 0,
    evidenceSummary,
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const ticker = args.find(a => !a.startsWith('--') && a !== args[args.indexOf('--lens') + 1]);
  if (!ticker) {
    console.error('Usage: node scripts/analysis/exportL2LensData.js <TICKER> [output.csv] [--lens <slug>] [--all-calls]');
    process.exit(1);
  }

  const upperTicker = ticker.toUpperCase();

  const lensIdx = args.indexOf('--lens');
  const lensSlug = lensIdx !== -1 ? args[lensIdx + 1] : null;

  const allCalls = args.includes('--all-calls');

  // Determine output file — first non-flag arg after ticker that isn't a --lens value
  const lensValue = lensIdx !== -1 ? args[lensIdx + 1] : null;
  const outFile = args.find(a =>
    !a.startsWith('--') && a !== upperTicker && a !== ticker && a !== lensValue
  ) ?? `${upperTicker}_lens_data${lensSlug ? '_' + lensSlug : ''}.csv`;

  // Fetch scores
  const where = {
    ticker: upperTicker,
    is_stale: false,
    ...(lensSlug ? { lens_slug: lensSlug } : {}),
  };

  let scores;
  if (allCalls) {
    scores = await prisma.lensScore.findMany({
      where,
      orderBy: [{ lens_slug: 'asc' }, { computed_at: 'desc' }],
    });
  } else {
    // Latest computed_at per (lens_slug) for this ticker
    const latest = await prisma.$queryRawUnsafe(`
      SELECT DISTINCT ON (lens_slug) id, call_id, ticker, lens_slug, z_score, signal_count,
             lens_config_v, lens_data, computed_at, is_stale
      FROM lens_scores
      WHERE ticker = $1 AND is_stale = false ${lensSlug ? `AND lens_slug = $2` : ''}
      ORDER BY lens_slug, computed_at DESC
    `, upperTicker, ...(lensSlug ? [lensSlug] : []));
    scores = latest;
  }

  // Enrich with fiscal_year + quarter from earnings_calls
  const callIds = [...new Set(scores.map(s => s.call_id))];
  const callMeta = await prisma.earnings_calls.findMany({
    where:  { id: { in: callIds } },
    select: { id: true, fiscal_year: true, quarter: true },
  });
  const callMetaMap = new Map(callMeta.map(c => [c.id, c]));
  for (const s of scores) {
    const meta = callMetaMap.get(s.call_id);
    s.fiscal_year = meta?.fiscal_year ?? '';
    s.quarter     = meta?.quarter     ?? '';
  }

  if (scores.length === 0) {
    console.error(`No lens scores found for ticker: ${upperTicker}${lensSlug ? ` / lens: ${lensSlug}` : ''}`);
    process.exit(1);
  }

  const summaryRows    = [SUMMARY_HEADER.join(',')];
  const topSignalRows  = [TOP_SIGNALS_HEADER.join(',')];
  const patternRows    = [PATTERNS_HEADER.join(',')];

  for (const score of scores) {
    const ld = score.lens_data ?? {};
    summaryRows.push(flattenSummary(score, ld));

    if (Array.isArray(ld.top_signals)) {
      for (const sig of ld.top_signals) {
        topSignalRows.push(flattenTopSignal(score, sig));
      }
    }

    if (Array.isArray(ld.patterns) && ld.patterns.length > 0) {
      for (const pat of ld.patterns) {
        patternRows.push(flattenPattern(score, pat));
      }
    }
  }

  const output = [
    sectionHeader('SUMMARY'),
    summaryRows.join('\n'),
    sectionHeader('TOP_SIGNALS'),
    topSignalRows.join('\n'),
    ...(patternRows.length > 1 ? [sectionHeader('PATTERNS'), patternRows.join('\n')] : []),
  ].join('\n');

  fs.writeFileSync(outFile, output, 'utf8');

  const absPath = path.resolve(outFile);
  console.log(`Exported ${scores.length} lens scores for ${upperTicker} → ${absPath}`);
  console.log(`  Summary rows    : ${summaryRows.length - 1}`);
  console.log(`  Top signal rows : ${topSignalRows.length - 1}`);
  if (patternRows.length > 1) {
    console.log(`  Pattern rows    : ${patternRows.length - 1}`);
  }
}

main()
  .catch(e => { console.error('ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
