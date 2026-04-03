'use strict';

const prisma = require('../config/prisma');

const { resolveProwess }                   = require('../utils/prowessResolver');
const { SOURCE_ABBRS, computeDerivedKpis } = require('../utils/finDerivedKpis');

// ─── Score helpers ────────────────────────────────────────────────────────────

function parseCallId(callId) {
  // e.g. "ADANIENSOL_FY2026_Q3" → { fiscalYear: 2026, quarter: 3 }
  const match = callId.match(/_FY(\d{4})_Q(\d)/);
  if (!match) return { fiscalYear: 0, quarter: 0 };
  return { fiscalYear: parseInt(match[1]), quarter: parseInt(match[2]) };
}

// Indian fiscal year: FY2026 Q1 = Apr–Jun 2025, Q2 = Jul–Sep 2025, Q3 = Oct–Dec 2025, Q4 = Jan–Mar 2026
function getQuarterEndDate(fiscalYear, quarter) {
  switch (quarter) {
    case 1: return new Date(`${fiscalYear - 1}-06-30`);
    case 2: return new Date(`${fiscalYear - 1}-09-30`);
    case 3: return new Date(`${fiscalYear - 1}-12-31`);
    case 4: return new Date(`${fiscalYear}-03-31`);
    default: return null;
  }
}

function calculateTransparencyScore(governanceSignals, riskDisclosures, undisclosedMissCount = 0) {
  let score = 50;
  if (governanceSignals?.transparent) score += 35;
  if (!governanceSignals?.defensive_language) score += 15;
  const earlyDisclosures = Array.isArray(riskDisclosures)
    ? riskDisclosures.filter(r => r.disclosed_early).length : 0;
  if (earlyDisclosures > 0) score += Math.min(earlyDisclosures * 5, 20);
  // Deduct for missed targets management never acknowledged in failure disclosures
  if (undisclosedMissCount > 0) score -= Math.min(undisclosedMissCount * 10, 30);
  return Math.max(0, Math.min(score, 100));
}

function calculateCapitalAllocationScore(governanceSignals) {
  let score = 50;
  if (governanceSignals?.capital_allocation_clarity) score += 30;
  if (governanceSignals?.transparent) score += 20;
  return Math.min(score, 100);
}

function calculateOverallScore(transparency, guidance, capital) {
  return Math.round(transparency * 0.4 + guidance * 0.35 + capital * 0.25);
}

function getOverallTrust(score) {
  return score >= 80 ? 'HIGH' : score >= 60 ? 'MODERATE' : 'LOW';
}

function getRating(score) {
  return score >= 70 ? 'HIGH' : score >= 50 ? 'MODERATE' : 'LOW';
}

function getConfidenceLevel(confidence) {
  return confidence ? confidence.toUpperCase() : 'MEDIUM';
}

// ─── Matching helpers ─────────────────────────────────────────────────────────

function matchTarget(goal, candidatePool, type) {
  if (type === 'financial') {
    return candidatePool.find(c => {
      if (c.kpi_abbr?.trim().toLowerCase() !== goal.kpi_abbr?.trim().toLowerCase()) return false;
      if (!c.target_time || !goal.target_time) return false;
      return new Date(c.target_time) < new Date(goal.target_time);
    }) ?? null;
  }

  return candidatePool.find(c => {
    const timeOk = c.target_time && goal.target_time
      ? new Date(c.target_time) < new Date(goal.target_time)
      : true;
    if (!timeOk) return false;

    if (c.concept && goal.concept) {
      return c.concept.toLowerCase().includes(goal.concept.toLowerCase()) ||
             goal.concept.toLowerCase().includes(c.concept.toLowerCase());
    }
    const goalWords = new Set(
      goal.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
    );
    const candWords = c.statement?.toLowerCase() ?? '';
    return [...goalWords].filter(w => candWords.includes(w)).length >= 3;
  }) ?? null;
}

function calcVariance(targeted, actual) {
  const t = parseFloat(targeted);
  const a = parseFloat(actual);
  if (isNaN(t) || isNaN(a) || t === 0) return null;
  return Math.round(((a - t) / Math.abs(t)) * 100);
}

const CRORE = 1e7;

function formatGuidanceValue(val, denomination) {
  if (val == null || typeof val !== 'number') return val;
  const sign = val < 0 ? '-' : '';
  let display = Math.abs(val);
  let suffix = '';
  switch (denomination) {
    case 'rupee':
      if (display >= 1e7) display = display / 1e7;
      suffix = ' Cr';
      break;
    case 'percentage': suffix = '%';  break;
    case 'ratio':      suffix = 'x';  break;
  }
  return `${sign}${display.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${suffix}`;
}

function normalizeActualUnit(targeted, actual) {
  if (targeted == null || actual == null || targeted === 0 || actual === 0) return actual;
  const ratio = Math.abs(actual / targeted);
  if (ratio >= 1e6 && ratio <= 1e8) return actual / CRORE;
  if (ratio <= 1e-6 && ratio >= 1e-9) return actual * CRORE;
  return actual;
}

// ─── Lookup builders ──────────────────────────────────────────────────────────

function groupMilestonesByCall(rows) {
  const map = {};
  for (const row of rows) {
    if (!map[row.callId]) map[row.callId] = { future_goals: [], success_disclosures: [], failure_disclosures: [] };
    (map[row.callId][row.category] ??= []).push(row);
  }
  return map;
}

function buildKpiValueLookup(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.callId}:::${row.kpi_abbr.trim().toLowerCase()}`, row.value);
  }
  return map;
}

function buildLatestKpiByAbbr(rows) {
  const map = new Map();
  const sorted = [...rows].sort((a, b) => {
    const pa = parseCallId(a.callId), pb = parseCallId(b.callId);
    if (pa.fiscalYear !== pb.fiscalYear) return pa.fiscalYear - pb.fiscalYear;
    return pa.quarter - pb.quarter;
  });
  for (const row of sorted) {
    if (row.value != null) map.set(row.kpi_abbr.trim().toLowerCase(), row.value);
  }
  return map;
}

// ─── Supplementary records from disclosures ───────────────────────────────────

function buildSupplementaryRecords(summaries, milestoneByCall, coveredFinKeys, coveredConKeys) {
  const supplement = [];
  let supId = 0;

  for (const s of summaries) {
    for (const disc of (milestoneByCall[s.callId]?.success_disclosures ?? [])) {
      const key = `${s.callId}:::${disc.kpi_abbr?.trim().toLowerCase()}`;
      if (!disc.statement || coveredFinKeys.has(key)) continue;
      coveredFinKeys.add(key);
      supplement.push({
        id:             `supp-${supId++}`,
        source_call:    s.callId,
        source_date:    s.callDate,
        period:         disc.target_time    ?? 'TBD',
        metric:         disc.kpi_abbr       ?? '',
        kpi_abbr:       disc.kpi_abbr       ?? '',
        statement:      disc.statement,
        targeted_value: disc.targeted_value ?? null,
        current_value:  disc.current_value  ?? null,
        variance_pct:   disc.targeted_value != null && disc.current_value != null
                          ? calcVariance(disc.targeted_value, disc.current_value) : null,
        status:         'ACHIEVED',
        target_type:    'financial',
      });
    }

    for (const disc of (milestoneByCall[s.callId]?.failure_disclosures ?? [])) {
      const key = `${s.callId}:::${disc.kpi_abbr?.trim().toLowerCase()}`;
      if (!disc.statement || coveredFinKeys.has(key)) continue;
      coveredFinKeys.add(key);
      supplement.push({
        id:             `supp-${supId++}`,
        source_call:    s.callId,
        source_date:    s.callDate,
        period:         disc.target_time    ?? 'TBD',
        metric:         disc.kpi_abbr       ?? '',
        kpi_abbr:       disc.kpi_abbr       ?? '',
        statement:      disc.statement,
        targeted_value: disc.targeted_value ?? null,
        current_value:  disc.current_value  ?? null,
        variance_pct:   disc.targeted_value != null && disc.current_value != null
                          ? calcVariance(disc.targeted_value, disc.current_value) : null,
        status:         'MISSED',
        target_type:    'financial',
      });
    }

    for (const [discList, isSuccess] of [
      [s.milestones?.success_disclosures?.conceptual_targets ?? [], true],
      [s.milestones?.failure_disclosures?.conceptual_targets ?? [], false],
    ]) {
      for (const disc of discList) {
        const key = `${s.callId}:::${disc.concept?.trim().toLowerCase()}`;
        if (!disc.statement || coveredConKeys.has(key)) continue;
        coveredConKeys.add(key);
        supplement.push({
          id:             `supp-${supId++}`,
          source_call:    s.callId,
          source_date:    s.callDate,
          period:         disc.target_time   ?? 'TBD',
          metric:         disc.concept       ?? '',
          statement:      disc.statement,
          targeted_value: disc.targeted_state ?? null,
          current_value:  disc.current_state  ?? null,
          variance_pct:   null,
          status:         isSuccess ? 'ACHIEVED' : 'MISSED',
          target_type:    'conceptual',
        });
      }
    }
  }
  return supplement;
}

// ─── Core guidance builder ────────────────────────────────────────────────────

const GUIDANCE_TOLERANCE_PCT = 5;

function buildGuidanceRecords(summaries, milestoneByCall, kpiValueLookup, latestKpiByAbbr) {
  const records = [];
  let recordId           = 0;
  let hiddenCount        = 0;
  let achievedCount      = 0;
  let missedCount        = 0;
  let undisclosedMissCount = 0;
  let weightedAchieved   = 0;
  let weightedMissed     = 0;
  let weightedHidden     = 0;

  const latestCallId = summaries[summaries.length - 1].callId;
  const { fiscalYear: latestFY, quarter: latestQ } = parseCallId(latestCallId);
  const latestCoveredDate = getQuarterEndDate(latestFY, latestQ) ?? new Date();

  const scorableSummaries = summaries.slice(0, summaries.length - 1);

  for (let i = 0; i < scorableSummaries.length; i++) {
    const source     = scorableSummaries[i];
    const subsequent = summaries.slice(i + 1);

    const allSuccessFinancial  = subsequent.flatMap(s => milestoneByCall[s.callId]?.success_disclosures ?? []);
    const allSuccessConceptual = subsequent.flatMap(s => s.milestones?.success_disclosures?.conceptual_targets ?? []);
    const allFailureFinancial  = subsequent.flatMap(s => milestoneByCall[s.callId]?.failure_disclosures ?? []);
    const allFailureConceptual = subsequent.flatMap(s => s.milestones?.failure_disclosures?.conceptual_targets ?? []);

    const resolveKpiValue = (match, kpiAbbr) => {
      if (!match) return null;
      if (match.current_value != null) return match.current_value;
      return kpiValueLookup.get(`${match.callId}:::${kpiAbbr?.trim().toLowerCase()}`) ?? null;
    };

    // ── Financial ──
    for (const goal of (milestoneByCall[source.callId]?.future_goals ?? [])) {
      const successMatch = matchTarget(goal, allSuccessFinancial, 'financial');
      const failureMatch = matchTarget(goal, allFailureFinancial, 'financial');

      const hasFutureCandidate = [...allSuccessFinancial, ...allFailureFinancial].some(c =>
        c.kpi_abbr?.trim().toLowerCase() === goal.kpi_abbr?.trim().toLowerCase() &&
        c.target_time && goal.target_time &&
        new Date(c.target_time) >= new Date(goal.target_time)
      );

      const successValue = resolveKpiValue(successMatch, goal.kpi_abbr);
      const failureValue = resolveKpiValue(failureMatch, goal.kpi_abbr);
      const rawCurrentValue = successValue ?? failureValue;
      const isDirectValue = successMatch?.current_value != null || failureMatch?.current_value != null;
      const matchedValue = isDirectValue
        ? normalizeActualUnit(goal.targeted_value, rawCurrentValue)
        : rawCurrentValue;
      const currentValue = matchedValue ?? latestKpiByAbbr.get(goal.kpi_abbr?.trim().toLowerCase()) ?? null;

      const deadlineIsFuture = goal.target_time && new Date(goal.target_time) > latestCoveredDate;
      const latestVariance    = currentValue != null ? calcVariance(goal.targeted_value, currentValue) : null;
      const successVariance   = successValue != null ? calcVariance(goal.targeted_value, successValue) : null;
      const targetActuallyMet = (successMatch && successVariance !== null && successVariance >= -GUIDANCE_TOLERANCE_PCT)
                              || (currentValue != null && latestVariance !== null && latestVariance >= -GUIDANCE_TOLERANCE_PCT);

      let status;
      if      (targetActuallyMet)                                        status = 'ACHIEVED';
      else if (failureMatch || (successMatch && !deadlineIsFuture))      status = 'MISSED';
      else if (currentValue != null && !deadlineIsFuture)                status = 'MISSED';
      else if (deadlineIsFuture || hasFutureCandidate)                   status = 'PENDING';
      else                                                               status = 'HIDDEN';

      if ((status === 'ACHIEVED' || status === 'MISSED') && currentValue === null) {
        status = 'KPI_MATCHING_NOT_FOUND';
      }

      if      (status === 'ACHIEVED') { achievedCount++; weightedAchieved += 2.0; }
      else if (status === 'MISSED')   { missedCount++; weightedMissed += 1.0; if (!failureMatch) undisclosedMissCount++; }
      else if (status === 'HIDDEN')   { hiddenCount++;   weightedHidden   += 0.3; }

      records.push({
        id:             `guidance-${recordId++}`,
        source_call:    source.callId,
        source_date:    source.callDate,
        period:         goal.target_time    ?? 'TBD',
        metric:         goal.kpi_abbr       ?? '',
        kpi_abbr:       goal.kpi_abbr       ?? '',
        statement:      goal.statement,
        targeted_value: goal.targeted_value ?? null,
        current_value:  currentValue,
        variance_pct:   status === 'ACHIEVED' || status === 'MISSED'
                          ? calcVariance(goal.targeted_value, currentValue)
                          : null,
        status:         status === 'MISSED' && !failureMatch ? 'MISSED_UNDISCLOSED' : status,
        target_type:    'financial',
      });
    }

    // ── Conceptual ──
    for (const goal of (source.milestones?.future_goals?.conceptual_targets ?? [])) {
      const successMatch = matchTarget(goal, allSuccessConceptual, 'conceptual');
      const failureMatch = matchTarget(goal, allFailureConceptual, 'conceptual');

      const hasFutureCandidate = [...allSuccessConceptual, ...allFailureConceptual].some(c => {
        const conceptMatch = c.concept && goal.concept &&
          (c.concept.toLowerCase().includes(goal.concept.toLowerCase()) ||
           goal.concept.toLowerCase().includes(c.concept.toLowerCase()));
        return conceptMatch &&
          c.target_time && goal.target_time &&
          new Date(c.target_time) >= new Date(goal.target_time);
      });

      const deadlineIsFuture = goal.target_time && new Date(goal.target_time) > latestCoveredDate;

      let status;
      if      (successMatch && !deadlineIsFuture) status = 'ACHIEVED';
      else if (failureMatch && !deadlineIsFuture) status = 'MISSED';
      else if (deadlineIsFuture || hasFutureCandidate) status = 'PENDING';
      else                                             status = 'HIDDEN';

      if      (status === 'ACHIEVED') { achievedCount++; weightedAchieved += 1.0; }
      else if (status === 'MISSED')   { missedCount++; weightedMissed += 0.7; if (!failureMatch) undisclosedMissCount++; }
      else if (status === 'HIDDEN')   { hiddenCount++;   weightedHidden   += 0.3; }

      records.push({
        id:             `guidance-${recordId++}`,
        source_call:    source.callId,
        source_date:    source.callDate,
        period:         goal.target_time    ?? 'TBD',
        metric:         goal.concept        ?? '',
        statement:      goal.statement,
        targeted_value: goal.targeted_state ?? null,
        current_value:  successMatch?.current_state ?? failureMatch?.current_state ?? null,
        variance_pct:   null,
        status:         status === 'MISSED' && !failureMatch ? 'MISSED_UNDISCLOSED' : status,
        target_type:    'conceptual',
      });
    }
  }

  const total          = achievedCount + missedCount + hiddenCount;
  const hitRate        = total > 0 ? Math.round((achievedCount / total) * 100) : 50;
  const weightedTotal  = weightedAchieved + weightedMissed + weightedHidden;
  const guidanceScore  = weightedTotal > 0 ? Math.round((weightedAchieved / weightedTotal) * 100) : 50;

  return { records, hiddenCount, achievedCount, missedCount, undisclosedMissCount, hitRate, guidanceScore };
}

// ─── Main service function ────────────────────────────────────────────────────

async function computeManagementAnalysis(callId, timeframe) {
  const companyPrefix = callId.split('_FY')[0];

  const [rawSummaries, callRecord, rawMilestones] = await Promise.all([
    prisma.summaryNew.findMany({
      where:   { callId: { startsWith: companyPrefix } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.earnings_calls.findFirst({
      where:   { company: companyPrefix },
      select:  { basic_industry: true, company_name: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    }),
    prisma.milestoneKpiTarget.findMany({ where: { company: companyPrefix } }),
  ]);

  if (rawSummaries.length === 0) {
    const err = new Error('No summaries found for this company');
    err.status = 404;
    throw err;
  }

  const summaries = rawSummaries
    .map(s => ({ ...s, callDate: s.createdAt }))
    .sort((a, b) => {
      const pa = parseCallId(a.callId);
      const pb = parseCallId(b.callId);
      if (pa.fiscalYear !== pb.fiscalYear) return pa.fiscalYear - pb.fiscalYear;
      return pa.quarter - pb.quarter;
    });

  const latest           = summaries[summaries.length - 1];
  const governanceSignals = latest.governanceSignals ?? {};
  const riskDisclosures  = Array.isArray(latest.riskDisclosures) ? latest.riskDisclosures : [];

  const milestoneAbbrs = [...new Set(rawMilestones.map(m => m.kpi_abbr))];
  const prowessMapping = resolveProwess(companyPrefix);
  let kpiValueRows = [];

  if (milestoneAbbrs.length > 0) {
    if (prowessMapping) {
      // Fetch direct prowess values + source abbrs for all available fiscal years
      const GROSS_PPE_ABBRS = ['ASSET_LAND_GRS', 'ASSET_PM_GRS'];
      const [directRows, sourceRows] = await Promise.all([
        prisma.prowessValueNew.findMany({
          where:  { company: prowessMapping.prowessName, kpi_abbr: { in: milestoneAbbrs } },
          select: { callId: true, kpi_abbr: true, value: true, multiplier: true, fiscal_year: true },
        }),
        prisma.prowessValueNew.findMany({
          where:  { company: prowessMapping.prowessName, kpi_abbr: { in: SOURCE_ABBRS } },
          select: { callId: true, kpi_abbr: true, value: true, multiplier: true, fiscal_year: true },
          orderBy: { fiscal_year: 'desc' },
        }),
      ]);

      // Group source rows by fiscal year; use latest for main KPIs
      const byFY = {};
      for (const r of sourceRows) (byFY[r.fiscal_year] ??= []).push(r);
      const sortedFYs = Object.keys(byFY).sort().reverse(); // e.g. ['FY2025','FY2024']
      const latestFY  = sortedFYs[0];
      const prevFY    = sortedFYs[1] ?? null;

      const anchor = byFY[latestFY]?.[0];
      if (anchor) {
        const sourceMap = Object.fromEntries(byFY[latestFY].map(r => [r.kpi_abbr, r]));
        // computeDerivedKpis expects display units (Cr / % / x), not absolute rupees
        const raw = Object.fromEntries(SOURCE_ABBRS.map(abbr => {
          const row = sourceMap[abbr];
          const val = row?.value != null ? row.value / (row.multiplier || 1) : null;
          return [abbr, [{ callId: anchor.callId, period: '', fiscal_year: '', quarter: '', call_date: '', value: val }]];
        }));

        const derived = computeDerivedKpis(raw, false /* non-BFSI */);

        // Delta CAPEX = Δ(ASSET_LAND_GRS + ASSET_PM_GRS) when previous year data exists
        if (prevFY) {
          const prevMap  = Object.fromEntries(byFY[prevFY].map(r => [r.kpi_abbr, r]));
          const grossLatest = GROSS_PPE_ABBRS.reduce((s, a) => {
            const r = sourceMap[a];
            return r?.value != null ? s + r.value / (r.multiplier || 1) : s;
          }, 0);
          const grossPrev = GROSS_PPE_ABBRS.reduce((s, a) => {
            const r = prevMap[a];
            return r?.value != null ? s + r.value / (r.multiplier || 1) : s;
          }, 0);
          const deltaCapex = grossLatest - grossPrev;
          if (deltaCapex > 0) derived['CAPEX'] = [{ ...derived['CAPEX']?.[0], value: deltaCapex }];
        }

        const directAbbrs = new Set(directRows.map(r => r.kpi_abbr.trim().toLowerCase()));
        const PCT_ABBRS   = new Set(['ROCE', 'ROA', 'ROE', 'EBIT_MARGIN']);

        for (const [abbr, series] of Object.entries(derived)) {
          if (directAbbrs.has(abbr.toLowerCase())) continue; // prowess already has it directly
          const val = series[0]?.value;
          if (val == null) continue;
          // Convert back to absolute units: Cr → rupees (×10M); % stays as-is (multiplier=1)
          directRows.push({ callId: anchor.callId, kpi_abbr: abbr, value: PCT_ABBRS.has(abbr) ? val : val * 1e7 });
        }
      }

      kpiValueRows = directRows.map(r => ({ callId: r.callId, kpi_abbr: r.kpi_abbr, value: r.value }));
    } else {
      kpiValueRows = await prisma.kpiValue.findMany({
        where:  { company: companyPrefix, kpi_abbr: { in: milestoneAbbrs } },
        select: { callId: true, kpi_abbr: true, value: true },
      });
    }
  }

  const milestoneByCall  = groupMilestonesByCall(rawMilestones);
  const kpiValueLookup   = buildKpiValueLookup(kpiValueRows);
  const latestKpiByAbbr  = buildLatestKpiByAbbr(kpiValueRows);

  const { records, hiddenCount, achievedCount, missedCount, undisclosedMissCount, hitRate, guidanceScore } =
    buildGuidanceRecords(summaries, milestoneByCall, kpiValueLookup, latestKpiByAbbr);

  // Use all milestone abbrs (covers future_goals + success/failure disclosures) for KPI metadata
  const kpiRows = milestoneAbbrs.length > 0
    ? await prisma.kpi.findMany({ where: { abbr: { in: milestoneAbbrs } }, select: { abbr: true, full_form: true, denomination: true } })
    : [];
  const kpiNameMap  = Object.fromEntries(kpiRows.map(k => [k.abbr.trim().toLowerCase(), k.full_form]));
  const kpiDenomMap = Object.fromEntries(kpiRows.map(k => [k.abbr.trim().toLowerCase(), k.denomination]));

  const STATUS_SORT = { MISSED_UNDISCLOSED: 0, MISSED: 1, ACHIEVED: 2, HIDDEN: 3, PENDING: 4, KPI_MATCHING_NOT_FOUND: 5 };
  const mappedAll = records.map(r => {
    const out = { ...r };
    if (r.target_type === 'financial') {
      out.metric = kpiNameMap[r.kpi_abbr?.trim().toLowerCase()] ?? r.kpi_abbr ?? '';
      const denomination = kpiDenomMap[r.kpi_abbr?.trim().toLowerCase()];
      out.targeted_value = formatGuidanceValue(r.targeted_value, denomination);
      out.current_value  = formatGuidanceValue(r.current_value, denomination);
    }
    delete out.kpi_abbr;
    return out;
  });
  const mapped = mappedAll
    .filter(r =>
      r.target_type === 'financial'
        ? (r.targeted_value != null && (r.current_value != null || r.status === 'PENDING' || r.status === 'MISSED_UNDISCLOSED'))
        : (r.statement != null && r.status !== 'HIDDEN')
    )
    .sort((a, b) => {
      const statusDiff = (STATUS_SORT[a.status] ?? 5) - (STATUS_SORT[b.status] ?? 5);
      if (statusDiff !== 0) return statusDiff;
      const typeRank = t => t === 'financial' ? 0 : 1;
      return typeRank(a.target_type) - typeRank(b.target_type);
    });

  const pick = (arr, n) => arr.slice(0, n);
  const byStatus = (...statuses) => mapped.filter(r => statuses.includes(r.status));
  const missedAll = byStatus('MISSED_UNDISCLOSED', 'MISSED');
  const primary = [
    ...missedAll,
    ...pick(byStatus('ACHIEVED'), 4),
    ...pick(byStatus('PENDING'),  2),
  ];
  const usedIds   = new Set(primary.map(r => r.id));
  const spillover = mapped.filter(r => !usedIds.has(r.id));
  let guidanceRecords = [...primary, ...spillover].slice(0, 14);

  // Supplement from success/failure disclosures when future_goals alone give < 14 records
  if (guidanceRecords.length < 14) {
    const coveredFinKeys = new Set(records
      .filter(r => r.target_type === 'financial')
      .map(r => `${r.source_call}:::${r.kpi_abbr?.trim().toLowerCase()}`));
    const coveredConKeys = new Set(records
      .filter(r => r.target_type === 'conceptual')
      .map(r => `${r.source_call}:::${r.metric?.trim().toLowerCase()}`));

    const suppRaw = buildSupplementaryRecords(summaries, milestoneByCall, coveredFinKeys, coveredConKeys);
    const suppMapped = suppRaw
      .map(r => {
        const out = { ...r };
        if (r.target_type === 'financial') {
          out.metric = kpiNameMap[r.kpi_abbr?.trim().toLowerCase()] ?? r.kpi_abbr ?? '';
          const denomination = kpiDenomMap[r.kpi_abbr?.trim().toLowerCase()];
          out.targeted_value = formatGuidanceValue(r.targeted_value, denomination);
          out.current_value  = formatGuidanceValue(r.current_value, denomination);
        }
        delete out.kpi_abbr;
        return out;
      })
      .filter(r =>
        r.target_type === 'financial'
          ? (r.targeted_value != null || r.current_value != null) && r.statement != null
          : r.statement != null
      );
    guidanceRecords = [...guidanceRecords, ...suppMapped].slice(0, 14);
  }

  const transparencyScore = calculateTransparencyScore(governanceSignals, riskDisclosures, undisclosedMissCount);
  const capitalScore      = calculateCapitalAllocationScore(governanceSignals);
  const overallScore      = calculateOverallScore(transparencyScore, guidanceScore, capitalScore);

  // Group all records (incl. HIDDEN) by status for hover lists on governance signal items
  const targetsByStatus = {};
  for (const r of mappedAll) {
    (targetsByStatus[r.status] ??= []).push({ metric: r.metric, statement: r.statement, period: r.period, targeted_value: r.targeted_value, current_value: r.current_value });
  }

  const governanceSignalsArray = [];
  let sigId = 1;
  if (governanceSignals.transparent) {
    const early = riskDisclosures.filter(r => r.disclosed_early);
    if (early.length > 0)
      governanceSignalsArray.push({ id: String(sigId++), text: `${early.length} risk(s) disclosed proactively`, isPositive: true, risks: early.map(r => ({ risk: r.risk, severity: r.severity ?? null, mitigation: r.mitigation ?? null })) });
    governanceSignalsArray.push({ id: String(sigId++), text: 'Management demonstrates transparency', isPositive: true });
  }
  if (governanceSignals.capital_allocation_clarity)
    governanceSignalsArray.push({ id: String(sigId++), text: 'Clear capital allocation strategy communicated', isPositive: true });
  if (governanceSignals.defensive_language)
    governanceSignalsArray.push({ id: String(sigId++), text: 'Defensive or evasive language detected', isPositive: false });
  if (achievedCount > 0)
    governanceSignalsArray.push({ id: String(sigId++), text: `${achievedCount} past target(s) achieved`, isPositive: true, targets: targetsByStatus['ACHIEVED'] ?? [] });
  if (missedCount > 0)
    governanceSignalsArray.push({ id: String(sigId++), text: `${missedCount} past target(s) missed`, isPositive: false, targets: targetsByStatus['MISSED'] ?? [] });
  if (undisclosedMissCount > 0)
    governanceSignalsArray.push({ id: String(sigId++), text: `${undisclosedMissCount} missed target(s) never acknowledged by management`, isPositive: false, targets: targetsByStatus['MISSED_UNDISCLOSED'] ?? [] });
  if (hiddenCount > 0)
    governanceSignalsArray.push({ id: String(sigId++), text: `${hiddenCount} past target(s) never revisited`, isPositive: false, targets: targetsByStatus['HIDDEN'] ?? [] });

  const notablePatterns = riskDisclosures.map((risk, i) => ({
    id:          `risk-${i}`,
    title:       risk.risk,
    description: risk.disclosed_early ? 'Disclosed proactively' : 'Disclosed when pressed',
    category:    risk.severity === 'high' ? 'negative' : risk.severity === 'low' ? 'positive' : 'neutral',
  }));

  return {
    company: {
      name:                latest.callId,
      company_name:        callRecord?.company_name ?? companyPrefix,
      exchange:            'NSE',
      industry:            callRecord?.basic_industry ?? null,
      confidenceLevel:     getConfidenceLevel(latest.confidence),
      transcriptsAnalyzed: summaries.length,
    },
    scores: [
      { factor: 'Guidance Accuracy',  rating: getRating(guidanceScore),     descriptor: hitRate >= 60 ? 'Consistent Delivery' : hitRate >= 30 ? 'Mixed Track Record' : 'Inconsistent' },
      { factor: 'Disclosure Honesty', rating: getRating(transparencyScore),  descriptor: transparencyScore >= 70 ? 'Transparent Ops' : transparencyScore >= 50 ? 'Adequate Disclosure' : 'Limited Transparency' },
      { factor: 'Capital Allocation', rating: getRating(capitalScore),       descriptor: capitalScore >= 70 ? 'Value Accretive' : capitalScore >= 50 ? 'Adequate Strategy' : 'Unclear Direction' },
    ],
    trust: {
      overall: getOverallTrust(overallScore),
      subfactors: {
        guidanceAccuracy:  guidanceScore,
        disclosureHonesty: transparencyScore,
        capitalAllocation: capitalScore,
      },
    },
    governanceSignals: governanceSignalsArray,
    consistency: {
      score:            Math.min(Math.round((overallScore / 100) * 40), 40),
      maxScore:         40,
      hitRate,
      hiddenCount,
      disclosurePattern: governanceSignals.transparent && riskDisclosures.some(r => r.disclosed_early)
        ? 'Early & Explicit'
        : governanceSignals.transparent ? 'Transparent' : 'Reactive',
    },
    guidanceRecords,
    notablePatterns,
    selectedTimeframe: timeframe,
  };
}

module.exports = { computeManagementAnalysis };
