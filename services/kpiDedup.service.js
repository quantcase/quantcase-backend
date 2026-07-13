'use strict';

/**
 * KPI dedup — phase 6 (per-industry KPI cap), extracted from
 * scripts/dedup_kpis.js so the same logic backs both the CLI script and the
 * admin-triggered endpoint (see routes/admin.kpiDedup.routes.js). Phases 1-5
 * remain script-only for now — only phase 6 was asked to be exposed to admins.
 *
 * For each industry, keeps the top-K KPIs by cross-company signal count,
 * drops the tail. A KPI is only deleted if it falls below the cap in EVERY
 * industry it belongs to (prevents removing a KPI that's highly used in a
 * second industry). Only touches the `kpis` table — unlike phases 2-5, this
 * never rewrites or deletes transcript_signals_v2 rows.
 */

const prisma = require('../config/prisma');

const PER_CO_MULTIPLIER = 18;
const CAP_MIN = 300;
const CAP_MAX = 1000;

const INDUSTRY_CAP_OVERRIDES = {
  // Metric-heavy regulated industries — formula undershoots
  'Private Sector Bank':            650,
  'Public Sector Bank':             600,
  'Non Banking Financial Company (NBFC)': 650,
  'NBFC':                           500,
  'Housing Finance Company':        500,
  'Life Insurance':                 500,
  'General Insurance':              450,
  'Microfinance Institutions':      400,
  'Financial Technology (Fintech)': 450,
  'Hospital':                       500,
  // Diversified / holding — many sub-segments inflate counts
  'Holding Company':                500,
  'Diversified':                    500,
};

function getIndustryCap(industry, companyCount) {
  if (INDUSTRY_CAP_OVERRIDES[industry] !== undefined) return INDUSTRY_CAP_OVERRIDES[industry];
  return Math.min(CAP_MAX, Math.max(CAP_MIN, companyCount * PER_CO_MULTIPLIER));
}

// execute: false (default) — report only, no deletes. execute: true — actually deletes.
async function runKpiDedupPhase6({ execute = false } = {}) {
  const [companyRows, allKpis] = await Promise.all([
    prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
      prisma.$queryRaw`
        SELECT basic_industry, COUNT(DISTINCT company)::int AS company_count
        FROM earnings_calls
        WHERE basic_industry IS NOT NULL
        GROUP BY basic_industry
      `,
    ]).then(([, rows]) => rows),
    prisma.kpi.findMany({
      where:  { source: 'transcript' },
      select: { abbr: true, industry: true },
    }),
  ]);
  const companyCountMap = new Map(companyRows.map(r => [r.basic_industry, Number(r.company_count)]));

  // Backed by a partial covering index (metric, call_id) WHERE is_invalidated
  // = false — see scripts/add_tsv2_metric_callid_index.sql. `metric` in
  // transcript_signals_v2 has ~2.3M distinct raw values (pre phases-1-5
  // canonicalization) but only the ~23k current kpi.abbr values are ever
  // looked up below (signalMap.get(kpi.abbr)) — constraining to that list
  // keeps the result set (and the Prisma row-transfer/deserialize cost) at
  // ~23k rows instead of shipping 2.3M unused rows back to Node.
  const kpiAbbrs = allKpis.map(k => k.abbr);
  const [, signalRows] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`),
    prisma.$queryRaw`
      SELECT metric, COUNT(DISTINCT call_id)::int AS co_count
      FROM transcript_signals_v2
      WHERE is_invalidated = false AND metric = ANY(${kpiAbbrs}::text[])
      GROUP BY metric
    `,
  ]);
  const signalMap = new Map(signalRows.map(r => [r.metric, Number(r.co_count)]));

  const overCapByIndustry = new Map(); // industry → Set of over-cap abbrs
  const industryKpis      = new Map(); // industry → [{abbr, coCount}]

  for (const kpi of allKpis) {
    for (const ind of kpi.industry) {
      if (!industryKpis.has(ind)) industryKpis.set(ind, []);
      industryKpis.get(ind).push({ abbr: kpi.abbr, coCount: signalMap.get(kpi.abbr) ?? 0 });
    }
  }

  let totalOverCapSlots = 0;
  const industries = [];
  for (const [ind, kpis] of industryKpis) {
    const cap = getIndustryCap(ind, companyCountMap.get(ind) ?? 1);
    kpis.sort((a, b) => b.coCount - a.coCount);
    const tail = kpis.slice(cap);
    if (tail.length) {
      overCapByIndustry.set(ind, new Set(tail.map(k => k.abbr)));
      totalOverCapSlots += tail.length;
    }
    industries.push({
      industry:     ind,
      companyCount: companyCountMap.get(ind) ?? 0,
      kpiCount:     kpis.length,
      cap,
      overCapCount: tail.length, // naive: over cap in THIS industry alone (pre cross-industry protection)
    });
  }

  // Only delete KPIs that are over-cap in ALL their industries — a KPI over-cap
  // here but protected by membership in another industry survives, so the
  // naive overCapCount above overstates how many of an industry's KPIs will
  // actually go. Tally the real per-industry deletions from the final list so
  // `remainingCount` (what the frontend shows) is accurate, not an estimate.
  const toDelete = [];
  for (const kpi of allKpis) {
    if (!kpi.industry.length) continue;
    const overInAll = kpi.industry.every(ind => overCapByIndustry.get(ind)?.has(kpi.abbr));
    if (overInAll) toDelete.push(kpi.abbr);
  }

  const abbrIndustries = new Map(allKpis.map(k => [k.abbr, k.industry]));
  const actualDeleteCountByIndustry = new Map();
  for (const abbr of toDelete) {
    for (const ind of abbrIndustries.get(abbr) ?? []) {
      actualDeleteCountByIndustry.set(ind, (actualDeleteCountByIndustry.get(ind) ?? 0) + 1);
    }
  }
  for (const ind of industries) {
    ind.actualDeleteCount = actualDeleteCountByIndustry.get(ind.industry) ?? 0;
    ind.remainingCount    = ind.kpiCount - ind.actualDeleteCount;
  }
  industries.sort((a, b) => b.kpiCount - a.kpiCount);

  const report = {
    dryRun:              !execute,
    industriesProcessed: industryKpis.size,
    totalOverCapSlots,
    totalKpisBefore:      allKpis.length,
    deletableCount:       toDelete.length,
    remainingCount:       allKpis.length - toDelete.length,
    deletableSample:      toDelete.slice(0, 50),
    industries,
  };

  if (!execute) return report;

  const CHUNK = 500;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk  = toDelete.slice(i, i + CHUNK);
    const result = await prisma.kpi.deleteMany({ where: { abbr: { in: chunk } } });
    deleted += result.count;
  }

  return { ...report, deletedCount: deleted };
}

module.exports = {
  runKpiDedupPhase6,
  getIndustryCap,
  INDUSTRY_CAP_OVERRIDES,
  PER_CO_MULTIPLIER,
  CAP_MIN,
  CAP_MAX,
};
