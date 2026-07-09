#!/usr/bin/env node
'use strict';

/**
 * KPI deduplication script — cleans the `kpis` table and canonicalizes
 * `transcript_signals_v2.metric` values, recording all mappings in `substitute_kpis`.
 *
 * All reads and writes use `transcript_signals_v2` (`extracted_signals` is deprecated).
 *
 * Phases:
 *   1 — Delete unused transcript KPIs (no transcript_signals_v2 rows)
 *   2 — Case/format dedup: same concept, different casing/spacing/punctuation
 *   3 — Semantic dedup: same full_form + same kpi_type, different abbr
 *   4 — Delete singleton transcript KPIs (appear exactly once in signals)
 *   5 — Delete malformed transcript KPIs (new_kpi% placeholders, starts-with-digit)
 *   6 — Per-industry KPI cap: keep top-K by cross-company signal count, drop the tail
 *
 * Usage:
 *   node scripts/dedup_kpis.js                         # dry-run all phases
 *   node scripts/dedup_kpis.js --phase 6               # dry-run phase 6 only
 *   node scripts/dedup_kpis.js --phase 6 --execute
 *   node scripts/dedup_kpis.js --execute               # run all phases
 *   node scripts/dedup_kpis.js --execute --kpis-only   # skip signal table ops (faster)
 */

require('dotenv').config();
const prisma = require('../config/prisma');
// Phase 6's per-industry cap config/logic lives in services/kpiDedup.service.js —
// shared with the admin-triggered endpoint (routes/admin.kpiDedup.routes.js).
const { runKpiDedupPhase6 } = require('../services/kpiDedup.service');

const DRY_RUN    = !process.argv.includes('--execute');
const KPIS_ONLY  = process.argv.includes('--kpis-only'); // skip signal table ops, only delete kpis rows
const phaseIdx   = process.argv.indexOf('--phase');
const ONLY_PHASE = phaseIdx !== -1 ? parseInt(process.argv[phaseIdx + 1]) : null;

const log  = (...a) => console.log(...a);
const sep  = () => console.log('-'.repeat(80));

// ─── Canonical selection ───────────────────────────────────────────────────────
// Priority: QE abbr > most-used in transcript_signals_v2 > UPPER_SNAKE_CASE > shortest

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

function pickCanonical(abbrs, qeSet, usageMap) {
  // 1. QE canonical wins unconditionally
  const qeMatch = abbrs.find(a => qeSet.has(a));
  if (qeMatch) return qeMatch;

  // 2. UPPER_SNAKE_CASE variants — pick most-used among them, then shortest
  const upper = abbrs.filter(a => UPPER_SNAKE.test(a));
  if (upper.length) {
    return upper.sort((a, b) => {
      const diff = (usageMap.get(b) ?? 0) - (usageMap.get(a) ?? 0);
      return diff !== 0 ? diff : a.length - b.length;
    })[0];
  }

  // 3. No UPPER_SNAKE variant — fall back to most-used of any case, then shortest
  return [...abbrs].sort((a, b) => {
    const diff = (usageMap.get(b) ?? 0) - (usageMap.get(a) ?? 0);
    return diff !== 0 ? diff : a.length - b.length;
  })[0];
}

// ─── Normalizer for case/format clustering ─────────────────────────────────────
function normalizeKey(abbr) {
  return abbr
    .toLowerCase()
    .replace(/[\s\-\.\(\)\/\\%#@!]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// ─── Core dedup executor (batch SQL — one round-trip per phase, not per variant) ──
async function applyDedup(clusters, usageMap, qeSet, phaseLabel) {
  const validClusters = [...clusters].filter(([, v]) => v.length > 0);
  if (validClusters.length === 0) return { totalClusters: 0, totalVariants: 0, totalSignalsUpdated: 0, totalKpisDeleted: 0 };

  const allVariants  = validClusters.flatMap(([, v]) => v);
  const totalClusters = validClusters.length;
  const totalVariants = allVariants.length;

  log(`  [${phaseLabel}] Processing ${totalClusters} clusters, ${totalVariants} variants...`);

  if (DRY_RUN) {
    validClusters.slice(0, 20).forEach(([c, v]) => log(`  canonical="${c}" ← ${v.join(', ')}`));
    if (validClusters.length > 20) log(`  ... +${validClusters.length - 20} more clusters`);
    return { totalClusters, totalVariants, totalSignalsUpdated: totalVariants, totalKpisDeleted: totalVariants };
  }

  if (!KPIS_ONLY) {
    // 1. Upsert substitute_kpis for all clusters in parallel (capped to avoid connection overload)
    const BATCH = 100;
    for (let i = 0; i < validClusters.length; i += BATCH) {
      await Promise.all(validClusters.slice(i, i + BATCH).map(([canonical, variants]) =>
        prisma.substituteKpi.upsert({
          where:  { primaryKpiAbbr: canonical },
          update: { substitutes: { push: variants } },
          create: { primaryKpiAbbr: canonical, substitutes: variants },
        }).catch(() => {
          // If push creates duplicates, do a full replace
          return prisma.substituteKpi.upsert({
            where:  { primaryKpiAbbr: canonical },
            update: {},
            create: { primaryKpiAbbr: canonical, substitutes: variants },
          });
        })
      ));
      process.stdout.write(`\r  substitute_kpis: ${Math.min(i + BATCH, validClusters.length)}/${validClusters.length}`);
    }
    log('');

    // 2. Batch-update transcript_signals_v2 — process in chunks to avoid statement timeout
    const SIGNAL_CHUNK = 200; // variants per SQL statement
    let updated = 0, deletedSignals = 0;

    const allMappings = validClusters.flatMap(([canonical, variants]) =>
      variants.map(v => ({ variant: v, canonical }))
    );

    for (let i = 0; i < allMappings.length; i += SIGNAL_CHUNK) {
      const chunk = allMappings.slice(i, i + SIGNAL_CHUNK);
      const mappingValues = chunk
        .map(({ variant, canonical }) => `('${variant.replace(/'/g, "''")}','${canonical.replace(/'/g, "''")}')`).join(',');
      const variantListChunk = chunk.map(({ variant }) => `'${variant.replace(/'/g, "''")}'`).join(',');

      // Use ROW_NUMBER to pick exactly one variant per unique-key slot when multiple
      // variants map to the same canonical — prevents intra-batch conflicts.
      const [, u, d] = await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
        prisma.$executeRawUnsafe(`
          WITH mapping(variant, canonical) AS (VALUES ${mappingValues}),
          ranked AS (
            SELECT ts.id, m.canonical,
                   ROW_NUMBER() OVER (
                     PARTITION BY ts.call_id, ts.signal_type, m.canonical,
                                  ts.source_hash, ts.prompt_v
                     ORDER BY ts.id
                   ) AS rn
            FROM transcript_signals_v2 ts
            JOIN mapping m ON ts.metric = m.variant
            WHERE NOT EXISTS (
              SELECT 1 FROM transcript_signals_v2 ts2
              WHERE ts2.call_id     = ts.call_id
                AND ts2.signal_type = ts.signal_type
                AND ts2.metric      = m.canonical
                AND ts2.source_hash = ts.source_hash
                AND ts2.prompt_v    = ts.prompt_v
            )
          )
          UPDATE transcript_signals_v2 ts
          SET metric = r.canonical
          FROM ranked r
          WHERE ts.id = r.id AND r.rn = 1
        `),
        prisma.$executeRawUnsafe(`DELETE FROM transcript_signals_v2 WHERE metric IN (${variantListChunk})`),
      ]);
      updated += u; deletedSignals += d;
      process.stdout.write(`\r  signals: chunk ${Math.min(i + SIGNAL_CHUNK, allMappings.length)}/${allMappings.length}`);
    }
    log(`\n  transcript_signals_v2 updated: ${updated}, dupes deleted: ${deletedSignals}`);
  } else {
    log(`  [kpis-only] skipping substitute_kpis + signal updates`);
  }

  // 3. Delete variant KPI rows
  const { count: kpisDeleted } = await prisma.kpi.deleteMany({ where: { abbr: { in: allVariants } } });
  log(`  kpis deleted: ${kpisDeleted}`);

  return { totalClusters, totalVariants, totalSignalsUpdated: 0, totalKpisDeleted: kpisDeleted };
}

// ─── Phase 1: Delete unused transcript KPIs ───────────────────────────────────
async function phase1() {
  log('\n══ PHASE 1 — Delete unused transcript KPIs ══');

  const unused = await prisma.$queryRaw`
    SELECT k.abbr, k.full_form, k.kpi_type
    FROM kpis k
    WHERE k.source = 'transcript'
      AND NOT EXISTS (
        SELECT 1 FROM transcript_signals_v2 ts WHERE ts.metric = k.abbr
      )
  `;

  log(`  Found ${unused.length} unused transcript KPIs`);

  if (!DRY_RUN) {
    const abbrs = unused.map(r => r.abbr);
    // Batch delete in chunks of 1000
    let deleted = 0;
    for (let i = 0; i < abbrs.length; i += 1000) {
      const chunk = abbrs.slice(i, i + 1000);
      const result = await prisma.kpi.deleteMany({ where: { abbr: { in: chunk } } });
      deleted += result.count;
      process.stdout.write(`\r  Deleted ${deleted}/${abbrs.length}...`);
    }
    log(`\n  Deleted ${deleted} unused KPI rows`);
  } else {
    log(`  [DRY RUN] Would delete ${unused.length} KPI rows`);
    unused.slice(0, 20).forEach(r => log(`    ${r.abbr.padEnd(40)} ${r.full_form?.substring(0, 40) ?? ''}`));
    if (unused.length > 20) log(`    ... +${unused.length - 20} more`);
  }
}

// ─── Phase 2: Case/format dedup ───────────────────────────────────────────────
async function phase2() {
  log('\n══ PHASE 2 — Case/format dedup ══');

  const [allTranscript, qeKpis, usageRows] = await Promise.all([
    prisma.kpi.findMany({ where: { source: 'transcript' }, select: { abbr: true, full_form: true, kpi_type: true } }),
    prisma.kpi.findMany({ where: { source: 'QE' }, select: { abbr: true } }),
    prisma.$queryRaw`
      SELECT metric, COUNT(*)::int as cnt
      FROM transcript_signals_v2
      WHERE is_invalidated = false
      GROUP BY metric
    `,
  ]);

  const qeSet   = new Set(qeKpis.map(k => k.abbr));
  const usageMap = new Map(usageRows.map(r => [r.metric, Number(r.cnt)]));

  // Build normalized clusters
  const normMap = new Map(); // normalizedKey → Set of abbrs
  for (const k of allTranscript) {
    const key = normalizeKey(k.abbr);
    if (!normMap.has(key)) normMap.set(key, []);
    normMap.get(key).push(k.abbr);
  }

  // Only clusters with >1 member
  const dupClusters = [...normMap.entries()].filter(([, abbrs]) => abbrs.length > 1);
  log(`  Found ${dupClusters.length} case/format clusters covering ${dupClusters.reduce((s,[,a])=>s+a.length,0)} abbrs`);

  // Resolve canonical per cluster
  const resolved = new Map(); // canonical → [variants to merge]
  for (const [, abbrs] of dupClusters) {
    const canonical = pickCanonical(abbrs, qeSet, usageMap);
    const variants  = abbrs.filter(a => a !== canonical);
    resolved.set(canonical, variants);
  }

  const stats = await applyDedup(resolved, usageMap, qeSet, 'P2');
  log(`\n  Phase 2 summary: ${stats.totalClusters} clusters, ${stats.totalVariants} variants merged`);
  log(`  transcript_signals_v2 updates: ${stats.totalSignalsUpdated}`);
  log(`  kpis deleted: ${stats.totalKpisDeleted}`);
}

// ─── Phase 3: Semantic dedup (same full_form + same kpi_type) ─────────────────
async function phase3() {
  log('\n══ PHASE 3 — Semantic dedup (same full_form + kpi_type) ══');

  const [allTranscript, qeKpis, usageRows] = await Promise.all([
    prisma.kpi.findMany({ where: { source: 'transcript' }, select: { abbr: true, full_form: true, kpi_type: true } }),
    prisma.kpi.findMany({ where: { source: 'QE' }, select: { abbr: true } }),
    prisma.$queryRaw`
      SELECT metric, COUNT(*)::int as cnt
      FROM transcript_signals_v2
      WHERE is_invalidated = false
      GROUP BY metric
    `,
  ]);

  const qeSet    = new Set(qeKpis.map(k => k.abbr));
  const usageMap = new Map(usageRows.map(r => [r.metric, Number(r.cnt)]));

  // Group by full_form + kpi_type (both must match for safe semantic merge)
  const semMap = new Map(); // "full_form|kpi_type" → [abbr]
  for (const k of allTranscript) {
    if (!k.full_form || !k.kpi_type) continue; // skip if missing either
    const key = `${k.full_form.trim().toLowerCase()}|${k.kpi_type}`;
    if (!semMap.has(key)) semMap.set(key, []);
    semMap.get(key).push(k.abbr);
  }

  const dupClusters = [...semMap.entries()].filter(([, abbrs]) => abbrs.length > 1);
  log(`  Found ${dupClusters.length} semantic clusters covering ${dupClusters.reduce((s,[,a])=>s+a.length,0)} abbrs`);

  // Show top clusters
  dupClusters.sort((a,b) => b[1].length - a[1].length).slice(0, 20).forEach(([key, abbrs]) => {
    const [form] = key.split('|');
    log(`  ${String(abbrs.length).padStart(3)}x  ${form.substring(0,45).padEnd(45)}  ${abbrs.slice(0,4).join(', ')}${abbrs.length>4?'...':''}`);
  });

  const resolved = new Map();
  for (const [, abbrs] of dupClusters) {
    const canonical = pickCanonical(abbrs, qeSet, usageMap);
    const variants  = abbrs.filter(a => a !== canonical);
    resolved.set(canonical, variants);
  }

  const stats = await applyDedup(resolved, usageMap, qeSet, 'P3');
  log(`\n  Phase 3 summary: ${stats.totalClusters} clusters, ${stats.totalVariants} variants merged`);
  log(`  transcript_signals_v2 updates: ${stats.totalSignalsUpdated}`);
  log(`  kpis deleted: ${stats.totalKpisDeleted}`);
}

// ─── Phase 4: Delete singleton transcript KPIs (appear exactly once ever) ────
async function phase4() {
  log('\n══ PHASE 4 — Delete singleton transcript KPIs (1 signal ever) ══');

  // Find transcript KPI abbrs with exactly 1 live signal across all companies
  const singletons = await prisma.$queryRawUnsafe(`
    SELECT k.abbr
    FROM kpis k
    JOIN (
      SELECT metric FROM transcript_signals_v2
      WHERE is_invalidated = false
      GROUP BY metric HAVING COUNT(*) = 1
    ) ts ON ts.metric = k.abbr
    WHERE k.source = 'transcript'
  `);

  const abbrs = singletons.map(r => r.abbr);
  log(`  Found ${abbrs.length} singleton transcript KPIs`);

  if (!DRY_RUN) {
    const CHUNK = 500;
    if (!KPIS_ONLY) {
      let sigDeleted = 0;
      for (let i = 0; i < abbrs.length; i += CHUNK) {
        const chunk = abbrs.slice(i, i + CHUNK);
        const inList = chunk.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
        const [, d] = await prisma.$transaction([
          prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
          prisma.$executeRawUnsafe(`DELETE FROM transcript_signals_v2 WHERE metric IN (${inList})`),
        ]);
        sigDeleted += d;
        process.stdout.write(`\r  signals deleted: ${sigDeleted}/${abbrs.length}`);
      }
      log('');
    } else {
      log(`  [kpis-only] skipping signal deletes`);
    }

    let kpiDeleted = 0;
    for (let i = 0; i < abbrs.length; i += CHUNK) {
      const chunk = abbrs.slice(i, i + CHUNK);
      const result = await prisma.kpi.deleteMany({ where: { abbr: { in: chunk } } });
      kpiDeleted += result.count;
      process.stdout.write(`\r  KPIs deleted: ${kpiDeleted}/${abbrs.length}`);
    }
    log(`\n  Deleted ${kpiDeleted} KPI rows`);
  } else {
    log(`  [DRY RUN] Would delete ${abbrs.length} KPI rows and their signals`);
    abbrs.slice(0, 20).forEach(a => log(`    ${a}`));
    if (abbrs.length > 20) log(`    ... +${abbrs.length - 20} more`);
  }
}

// ─── Phase 5: Delete structurally malformed transcript KPIs ─────────────────
// Targets two unambiguously garbage patterns:
//   a) new_kpi% random hash placeholders (LLM couldn't find a real abbr)
//   b) abbr starts with a digit (e.g. "13.46_MN", "25.94" — values, not KPI names)
async function phase5() {
  log('\n══ PHASE 5 — Delete malformed transcript KPIs ══');

  const garbage = await prisma.$queryRawUnsafe(`
    SELECT abbr FROM kpis
    WHERE source = 'transcript'
      AND (
        abbr ILIKE 'new_kpi%'
        OR abbr ~ '^[0-9]'
      )
  `);

  const abbrs = garbage.map(r => r.abbr);
  log(`  Found ${abbrs.length} malformed transcript KPIs`);

  const counts = {
    newKpi:      abbrs.filter(a => /^new_kpi/i.test(a)).length,
    startsDigit: abbrs.filter(a => /^[0-9]/.test(a)).length,
  };
  log(`    new_kpi% placeholders : ${counts.newKpi}`);
  log(`    starts with digit     : ${counts.startsDigit}`);

  if (DRY_RUN) {
    log(`  [DRY RUN] Would delete ${abbrs.length} KPI rows and their v2 signals`);
    abbrs.slice(0, 20).forEach(a => log(`    ${a}`));
    if (abbrs.length > 20) log(`    ... +${abbrs.length - 20} more`);
    return;
  }

  const CHUNK = 500;
  if (!KPIS_ONLY) {
    let sigDeleted = 0;
    for (let i = 0; i < abbrs.length; i += CHUNK) {
      const chunk = abbrs.slice(i, i + CHUNK);
      const inList = chunk.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
      const [, d] = await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
        prisma.$executeRawUnsafe(`DELETE FROM transcript_signals_v2 WHERE metric IN (${inList})`),
      ]);
      sigDeleted += d;
      process.stdout.write(`\r  v2 signals deleted: ${sigDeleted}`);
    }
    log('');
  } else {
    log(`  [kpis-only] skipping signal deletes`);
  }

  let kpiDeleted = 0;
  for (let i = 0; i < abbrs.length; i += CHUNK) {
    const chunk = abbrs.slice(i, i + CHUNK);
    const result = await prisma.kpi.deleteMany({ where: { abbr: { in: chunk } } });
    kpiDeleted += result.count;
    process.stdout.write(`\r  KPIs deleted: ${kpiDeleted}/${abbrs.length}`);
  }
  log(`\n  Deleted ${kpiDeleted} KPI rows`);
}

// ─── Phase 6: Per-industry KPI cap ────────────────────────────────────────────
// For each industry, keeps the top-K KPIs by cross-company signal count.
// A KPI is only deleted if it falls below the cap in EVERY industry it belongs to
// (prevents removing a KPI that's highly used in a second industry).
// Logic lives in services/kpiDedup.service.js — this just prints the report.
async function phase6() {
  log('\n══ PHASE 6 — Per-industry KPI cap ══');

  const report = await runKpiDedupPhase6({ execute: !DRY_RUN });

  log(`  Industries processed: ${report.industriesProcessed}`);
  log(`  Total over-cap slots: ${report.totalOverCapSlots}`);
  log(`  Transcript KPIs total: ${report.totalKpisBefore}`);
  log(`  KPIs deletable (over-cap in ALL their industries): ${report.deletableCount}`);
  log(`  KPIs remaining after: ${report.remainingCount}`);

  const topInds = report.industries.slice(0, 20);
  log('\n  industry'.padEnd(53) + 'cos'.padStart(5) + 'kpis'.padStart(7) + 'cap'.padStart(6) + 'del'.padStart(6) + 'rem'.padStart(7));
  for (const ind of topInds) {
    log(`  ${ind.industry.padEnd(50)}${String(ind.companyCount).padStart(5)}${String(ind.kpiCount).padStart(7)}${String(ind.cap).padStart(6)}${String(ind.actualDeleteCount).padStart(6)}${String(ind.remainingCount).padStart(7)}`);
  }

  if (DRY_RUN) {
    log(`\n  [DRY RUN] Would delete ${report.deletableCount} KPI rows`);
    report.deletableSample.slice(0, 20).forEach(a => log(`    ${a}`));
    if (report.deletableCount > 20) log(`    ... +${report.deletableCount - 20} more`);
    return;
  }

  log(`\n  Deleted ${report.deletedCount} KPI rows`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`\nKPI DEDUP — ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : '*** LIVE EXECUTION ***'}`);
  log(`Phase filter: ${ONLY_PHASE ?? 'all'}`);
  sep();

  const before = await prisma.kpi.count({ where: { source: 'transcript' } });
  log(`Transcript KPIs before: ${before}`);

  if (!ONLY_PHASE || ONLY_PHASE === 1) await phase1();
  if (!ONLY_PHASE || ONLY_PHASE === 2) await phase2();
  if (!ONLY_PHASE || ONLY_PHASE === 3) await phase3();
  if (!ONLY_PHASE || ONLY_PHASE === 4) await phase4();
  if (!ONLY_PHASE || ONLY_PHASE === 5) await phase5();
  if (!ONLY_PHASE || ONLY_PHASE === 6) await phase6();

  const after = await prisma.kpi.count({ where: { source: 'transcript' } });
  sep();
  log(`Transcript KPIs after:  ${after}  (removed: ${before - after})`);
  log('Done.\n');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
