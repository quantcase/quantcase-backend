#!/usr/bin/env node
'use strict';

/**
 * KPI deduplication script — cleans the `kpis` table and canonicalizes
 * `extracted_signals.metric` values, recording all mappings in `substitute_kpis`.
 *
 * Phases:
 *   1 — Delete unused transcript KPIs (no extracted_signals rows)
 *   2 — Case/format dedup: same concept, different casing/spacing/punctuation
 *   3 — Semantic dedup: same full_form + same kpi_type, different abbr
 *
 * Usage:
 *   node scripts/dedup_kpis.js                    # dry-run all phases
 *   node scripts/dedup_kpis.js --phase 1          # dry-run phase 1 only
 *   node scripts/dedup_kpis.js --phase 2 --execute
 *   node scripts/dedup_kpis.js --execute          # run all phases
 */

require('dotenv').config();
const prisma = require('../config/prisma');

const DRY_RUN = !process.argv.includes('--execute');
const phaseIdx = process.argv.indexOf('--phase');
const ONLY_PHASE = phaseIdx !== -1 ? parseInt(process.argv[phaseIdx + 1]) : null;

const log  = (...a) => console.log(...a);
const sep  = () => console.log('-'.repeat(80));

// ─── Canonical selection ───────────────────────────────────────────────────────
// Priority: QE abbr > most-used in extracted_signals > UPPER_SNAKE_CASE > shortest

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

  // 2. Batch-update extracted_signals — process in chunks to avoid statement timeout
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
          SELECT es.id, m.canonical,
                 ROW_NUMBER() OVER (
                   PARTITION BY es.call_id, es.signal_type, m.canonical,
                                es.source_hash, es.prompt_v, es.start_date
                   ORDER BY es.id
                 ) AS rn
          FROM extracted_signals es
          JOIN mapping m ON es.metric = m.variant
          WHERE NOT EXISTS (
            SELECT 1 FROM extracted_signals es2
            WHERE es2.call_id     = es.call_id
              AND es2.signal_type = es.signal_type
              AND es2.metric      = m.canonical
              AND es2.source_hash = es.source_hash
              AND es2.prompt_v    = es.prompt_v
              AND es2.start_date  IS NOT DISTINCT FROM es.start_date
          )
        )
        UPDATE extracted_signals es
        SET metric = r.canonical
        FROM ranked r
        WHERE es.id = r.id AND r.rn = 1
      `),
      prisma.$executeRawUnsafe(`DELETE FROM extracted_signals WHERE metric IN (${variantListChunk})`),
    ]);
    updated += u; deletedSignals += d;
    process.stdout.write(`\r  signals: chunk ${Math.min(i + SIGNAL_CHUNK, allMappings.length)}/${allMappings.length}`);
  }
  log(`\n  extracted_signals updated: ${updated}, dupes deleted: ${deletedSignals}`);

  // 3. Delete variant KPI rows
  const { count: kpisDeleted } = await prisma.kpi.deleteMany({ where: { abbr: { in: allVariants } } });
  log(`  kpis deleted: ${kpisDeleted}`);

  return { totalClusters, totalVariants, totalSignalsUpdated: updated, totalKpisDeleted: kpisDeleted };
}

// ─── Phase 1: Delete unused transcript KPIs ───────────────────────────────────
async function phase1() {
  log('\n══ PHASE 1 — Delete unused transcript KPIs ══');

  const unused = await prisma.$queryRaw`
    SELECT k.abbr, k.full_form, k.kpi_type
    FROM kpis k
    WHERE k.source = 'transcript'
      AND NOT EXISTS (
        SELECT 1 FROM extracted_signals es WHERE es.metric = k.abbr
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
      FROM extracted_signals
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
  log(`  extracted_signals updates: ${stats.totalSignalsUpdated}`);
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
      FROM extracted_signals
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
  log(`  extracted_signals updates: ${stats.totalSignalsUpdated}`);
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
      SELECT metric FROM extracted_signals
      WHERE is_invalidated = false
      GROUP BY metric HAVING COUNT(*) = 1
    ) es ON es.metric = k.abbr
    WHERE k.source = 'transcript'
  `);

  const abbrs = singletons.map(r => r.abbr);
  log(`  Found ${abbrs.length} singleton transcript KPIs`);

  if (!DRY_RUN) {
    // Delete signals first (batched), then KPI rows
    const CHUNK = 500;
    let sigDeleted = 0;
    for (let i = 0; i < abbrs.length; i += CHUNK) {
      const chunk = abbrs.slice(i, i + CHUNK);
      const inList = chunk.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
      const [, d] = await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
        prisma.$executeRawUnsafe(`DELETE FROM extracted_signals WHERE metric IN (${inList})`),
      ]);
      sigDeleted += d;
      process.stdout.write(`\r  signals deleted: ${sigDeleted}/${abbrs.length}`);
    }
    log('');

    let kpiDeleted = 0;
    for (let i = 0; i < abbrs.length; i += CHUNK) {
      const chunk = abbrs.slice(i, i + CHUNK);
      const result = await prisma.kpi.deleteMany({ where: { abbr: { in: chunk } } });
      kpiDeleted += result.count;
      process.stdout.write(`\r  KPIs deleted: ${kpiDeleted}/${abbrs.length}`);
    }
    log(`\n  Deleted ${sigDeleted} signals and ${kpiDeleted} KPI rows`);
  } else {
    log(`  [DRY RUN] Would delete ${abbrs.length} KPI rows and their signals`);
    abbrs.slice(0, 20).forEach(a => log(`    ${a}`));
    if (abbrs.length > 20) log(`    ... +${abbrs.length - 20} more`);
  }
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

  const after = await prisma.kpi.count({ where: { source: 'transcript' } });
  sep();
  log(`Transcript KPIs after:  ${after}  (removed: ${before - after})`);
  log('Done.\n');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
