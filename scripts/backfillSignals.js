#!/usr/bin/env node
'use strict';

/**
 * Backfill the Signal Store (extracted_signals table) from legacy data:
 *   - kpi_values (transcript source) → signal_type: 'kpi'
 *   - oFactorResult sections (final_scoring.score) → signal_type: 'ofactor_section'
 *   - aiInsight (type=management, numeric scores) → signal_type: 'management_score'
 *
 * All backfilled rows use source_hash='legacy' and prompt_v='legacy' to distinguish
 * them from live-extracted signals. They are NOT invalidatable via prompt version.
 *
 * Run: node scripts/backfillSignals.js [--dry-run]
 *
 * Flags:
 *   --dry-run  Log counts without writing to DB
 *   --batch N  Process N calls at a time (default: 50)
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const prisma = require('../config/prisma');

const DRY_RUN   = process.argv.includes('--dry-run');
const BATCH_IDX = process.argv.indexOf('--batch');
const BATCH     = BATCH_IDX !== -1 ? parseInt(process.argv[BATCH_IDX + 1]) || 50 : 50;

const OFACTOR_SECTION_METRICS = {
  industry_overview:    'industry_overview_score',
  competition:          'competition_score',
  financial_strength:   'financial_strength_score',
  customer_traction:    'customer_traction_score',
};

const MANAGEMENT_SCORE_FIELDS = [
  'guidance_accuracy',
  'capital_allocation_quality',
  'governance_quality',
  'track_record_score',
  'overall_score',
];

// ─── KPI values backfill ──────────────────────────────────────────────────────

async function backfillKpiValues() {
  console.log('\n── Backfilling KPI signals from kpi_values (transcript source)...');
  const calls = await prisma.kpiValue.findMany({
    where:    { source: 'transcript' },
    select:   { callId: true },
    distinct: ['callId'],
  });
  console.log(`  Found ${calls.length} distinct callIds`);
  let total = 0;

  for (let i = 0; i < calls.length; i += BATCH) {
    const batch = calls.slice(i, i + BATCH);
    const callIds = batch.map(c => c.callId);
    const rows = await prisma.kpiValue.findMany({
      where: { callId: { in: callIds }, source: 'transcript' },
    });

    const callMetaMap = new Map();
    for (const r of rows) {
      if (!callMetaMap.has(r.callId)) {
        const ec = await prisma.earnings_calls.findUnique({
          where:  { id: r.callId },
          select: { company: true },
        }).catch(() => null);
        callMetaMap.set(r.callId, ec?.company ?? r.company);
      }
    }

    const signals = rows.map(r => ({
      call_id:         r.callId,
      ticker:          callMetaMap.get(r.callId) ?? r.company,
      company:         r.company,
      fiscal_year:     r.fiscal_year ?? null,
      quarter:         r.quarter     ?? null,
      call_date:       r.call_date   ?? null,
      source_type:     'transcript',
      signal_type:     'kpi',
      metric:          r.kpi_abbr,
      value:           r.value,
      raw_value:       r.raw_value ?? null,
      unit:            r.unit     ?? null,
      multiplier:      r.multiplier,
      start_date:      r.start_date ?? null,
      end_date:        r.end_date   ?? null,
      period_type:     r.period_type ?? null,
      statement:       r.statement  ?? null,
      source_hash:     'legacy',
      prompt_v:        'legacy',
      schema_v:        '1.0.0',
      extractor_model: 'legacy',
      lineage_id:      randomUUID(),
      metric_family:   'growth',
      w:               1.0,
      b:               0.0,
      is_invalidated:  false,
    }));

    if (!DRY_RUN && signals.length > 0) {
      const result = await prisma.extractedSignal.createMany({ data: signals, skipDuplicates: true });
      total += result.count;
    } else {
      total += signals.length;
    }
    process.stdout.write(`  Progress: ${Math.min(i + BATCH, calls.length)}/${calls.length} calls\r`);
  }
  console.log(`\n  Wrote ${total} KPI signals ${DRY_RUN ? '(dry run)' : ''}`);
}

// ─── OFactor results backfill ─────────────────────────────────────────────────

async function backfillOFactorResults() {
  console.log('\n── Backfilling ofactor section signals from oFactorResult...');
  const results = await prisma.oFactorResult.findMany();
  console.log(`  Found ${results.length} oFactorResult rows`);
  let total = 0;

  for (const ofr of results) {
    const r = ofr.result;
    if (!r || typeof r !== 'object') continue;

    const ec = await prisma.earnings_calls.findUnique({
      where:  { id: ofr.callId },
      select: { company: true, fiscal_year: true, quarter: true, call_date: true },
    }).catch(() => null);

    const signals = [];
    for (const [section, metric] of Object.entries(OFACTOR_SECTION_METRICS)) {
      const sectionData = r[section];
      const score = sectionData?.final_scoring?.score;
      if (score == null || isNaN(parseFloat(score))) continue;
      signals.push({
        call_id:         ofr.callId,
        ticker:          ofr.subjectTicker,
        company:         ec?.company ?? ofr.subjectTicker,
        fiscal_year:     ec?.fiscal_year ?? null,
        quarter:         ec?.quarter     ?? null,
        call_date:       ec?.call_date   ?? null,
        source_type:     'ofactor',
        signal_type:     'ofactor_section',
        metric,
        value:           parseFloat(score),
        raw_value:       String(score),
        metric_family:   'ofactor',
        source_hash:     'legacy',
        prompt_v:        'legacy',
        schema_v:        '1.0.0',
        extractor_model: 'legacy',
        lineage_id:      randomUUID(),
        w:               0.25,
        b:               0.0,
        is_invalidated:  false,
      });
    }

    if (!DRY_RUN && signals.length > 0) {
      const result = await prisma.extractedSignal.createMany({ data: signals, skipDuplicates: true });
      total += result.count;
    } else {
      total += signals.length;
    }
  }
  console.log(`  Wrote ${total} ofactor signals ${DRY_RUN ? '(dry run)' : ''}`);
}

// ─── Management scores backfill ───────────────────────────────────────────────

async function backfillManagementInsights() {
  console.log('\n── Backfilling management score signals from aiInsight...');
  const insights = await prisma.aiInsight.findMany({ where: { type: 'management' } });
  console.log(`  Found ${insights.length} management aiInsight rows`);
  let total = 0;

  for (const ai of insights) {
    const r = ai.insight;
    if (!r || typeof r !== 'object') continue;

    const signals = MANAGEMENT_SCORE_FIELDS
      .filter(f => r[f] != null && !isNaN(parseFloat(r[f])))
      .map(f => ({
        call_id:         `${ai.ticker}_legacy`,
        ticker:          ai.ticker,
        company:         ai.ticker,
        fiscal_year:     null,
        quarter:         null,
        call_date:       null,
        source_type:     'management',
        signal_type:     'management_score',
        metric:          f,
        value:           parseFloat(r[f]),
        raw_value:       String(r[f]),
        metric_family:   'management',
        source_hash:     'legacy',
        prompt_v:        'legacy',
        schema_v:        '1.0.0',
        extractor_model: 'legacy',
        lineage_id:      randomUUID(),
        w:               1.0,
        b:               0.0,
        is_invalidated:  false,
      }));

    if (!DRY_RUN && signals.length > 0) {
      const result = await prisma.extractedSignal.createMany({ data: signals, skipDuplicates: true });
      total += result.count;
    } else {
      total += signals.length;
    }
  }
  console.log(`  Wrote ${total} management signals ${DRY_RUN ? '(dry run)' : ''}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will occur\n');
  console.log(`Batch size: ${BATCH}`);

  await backfillKpiValues();
  await backfillOFactorResults();
  await backfillManagementInsights();

  console.log('\nBackfill complete.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
