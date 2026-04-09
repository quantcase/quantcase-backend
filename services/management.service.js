'use strict';

const prisma = require('../config/prisma');

const { resolveProwess }                   = require('../utils/prowessResolver');
const { SOURCE_ABBRS, computeDerivedKpis } = require('../utils/finDerivedKpis');

// ─── Disclosures normalizer ───────────────────────────────────────────────────

// Returns a flat array of disclosures with keys:
// { disclosure_type, disclosure_title, disclosure_timing, mitigation_strategy, severity }
function normalizeDisclosures(raw) {
  if (!raw) return [];
  // Current schema: flat array with disclosure_type key
  if (Array.isArray(raw)) return raw;
  // Legacy grouped schema: { risk: [], bad_news: [], legal_issues: [] }
  if (typeof raw === 'object') {
    const result = [];
    for (const r of (raw.risk ?? [])) {
      result.push({
        disclosure_type:    'risk',
        disclosure_title:   r.risk_title ?? r.risk ?? '',
        disclosure_timing:  'reactive',
        mitigation_strategy: r.mitigation_strategy ?? null,
        severity:           r.risk_type?.toLowerCase().includes('high') ? 'high' : 'medium',
      });
    }
    for (const b of (raw.bad_news ?? [])) {
      result.push({
        disclosure_type:    'bad_news',
        disclosure_title:   b.news_title ?? '',
        disclosure_timing:  b.disclosure_type ?? 'reactive',
        mitigation_strategy: b.mitigation_strategy ?? null,
        severity:           'medium',
      });
    }
    for (const l of (raw.legal_issues ?? [])) {
      result.push({
        disclosure_type:    'legal',
        disclosure_title:   l.issue_title ?? '',
        disclosure_timing:  l.issue_type === 'past' ? 'past' : 'reactive',
        mitigation_strategy: null,
        severity:           'high',
      });
    }
    return result;
  }
  return [];
}

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

function calculateTransparencyScore(governanceSignals, disclosures, undisclosedMissCount = 0) {
  let score = 50;
  if (governanceSignals?.transparent) score += 35;
  if (!governanceSignals?.defensive_language) score += 15;
  const earlyDisclosures = Array.isArray(disclosures)
    ? disclosures.filter(d => d.disclosure_timing === 'proactive').length
    : 0;
  if (earlyDisclosures > 0) score += Math.min(earlyDisclosures * 5, 20);
  // Deduct for missed targets management never acknowledged
  if (undisclosedMissCount > 0) score -= Math.min(undisclosedMissCount * 10, 30);
  return Math.max(0, Math.min(score, 100));
}

// ─── Capital Allocation builder ───────────────────────────────────────────────

/**
 * Format a Cr value (display units) into a human-readable label.
 * e.g. 27800 Cr → "$27.8B" (using generic currency symbol; callers can adjust)
 */
function formatCrLabel(crValue) {
  if (crValue == null) return null;
  const b = crValue / 100000; // 1 lakh Cr = 1B (approx for INR in context)
  if (Math.abs(b) >= 1)  return `₹${parseFloat(b.toFixed(1))}T`;
  const billions = crValue / 10000; // 1 Cr = 1e7 rupees; 10000 Cr = 1B rupees
  if (Math.abs(billions) >= 1) return `₹${parseFloat(billions.toFixed(1))}B`;
  return `₹${parseFloat(crValue.toFixed(0))}Cr`;
}

/**
 * Build capex_breakdown and roce_trend from multi-year Prowess data (byFY map).
 * byFY: { 'FY2025': [prowessValueNew rows], 'FY2024': [...], ... }
 * Each row: { kpi_abbr, value (absolute rupees), multiplier, fiscal_year }
 */
function computeCapitalAllocation(byFY, sortedFYs) {
  // ── helpers ──────────────────────────────────────────────────────────────
  const getCr = (fyMap, abbr) => {
    const r = fyMap[abbr];
    if (!r || r.value == null) return null;
    return r.value / (r.multiplier || 1); // display units (Cr)
  };

  const toFyMap = (rows) => Object.fromEntries(rows.map(r => [r.kpi_abbr, r]));

  const GROSS_PPE = ['ASSET_LAND_GRS', 'ASSET_PM_GRS'];

  // Pre-compute delta CAPEX and CFF per (latestFY, prevFY) pair — used across timeframes
  const capexDeltaByFY = {}; // capexDeltaByFY['FY2025'] = delta from FY2024→FY2025
  const cffByFY = {};
  for (let i = 0; i < sortedFYs.length; i++) {
    const fy = sortedFYs[i];
    const fyMap = toFyMap(byFY[fy] ?? []);
    cffByFY[fy] = getCr(fyMap, 'CFF');
    if (i < sortedFYs.length - 1) {
      const prevMap = toFyMap(byFY[sortedFYs[i + 1]] ?? []);
      const gL = GROSS_PPE.reduce((s, a) => { const v = getCr(fyMap, a); return v != null ? s + v : s; }, 0);
      const gP = GROSS_PPE.reduce((s, a) => { const v = getCr(prevMap, a); return v != null ? s + v : s; }, 0);
      capexDeltaByFY[fy] = gL > gP ? gL - gP : null;
    }
  }

  // ── capex breakdown for a specific timeframe window ──────────────────────
  const buildCapexBreakdown = (fyCount) => {
    // For "last_quarter" use the latest year only (no delta possible without prev year)
    // For others we need fyCount FYs of delta capex, so fyCount+1 raw FYs
    if (sortedFYs.length < 2) return null;

    const windowFYs = sortedFYs.slice(0, fyCount + 1);
    if (windowFYs.length < 2) return null;

    // Sum capex deltas across all years in window
    let totalCapexCr = 0;
    let capexCount = 0;
    for (const fy of windowFYs.slice(0, -1)) { // exclude oldest (no delta)
      if (capexDeltaByFY[fy] != null) { totalCapexCr += capexDeltaByFY[fy]; capexCount++; }
    }
    const capexCr = capexCount > 0 ? totalCapexCr : null;

    // Shareholder return: sum of |CFF| where CFF < 0 across window years
    let totalShareholder = 0;
    let shCount = 0;
    for (const fy of windowFYs.slice(0, -1)) {
      const cff = cffByFY[fy];
      if (cff != null && cff < 0) { totalShareholder += Math.abs(cff); shCount++; }
    }
    const shareholder = shCount > 0 ? totalShareholder : null;

    const parts = [
      { name: 'Capex',             value: capexCr },
      { name: 'Shareholder Return', value: shareholder },
    ].filter(p => p.value != null && p.value > 0);

    if (parts.length === 0) return null;

    const total = parts.reduce((s, p) => s + p.value, 0);

    // 5-year average capex for vs_5yr_avg_pct
    const hist5 = sortedFYs.slice(0, 6); // up to 5 deltas
    const hist5Values = hist5.slice(0, -1).map(fy => capexDeltaByFY[fy]).filter(v => v != null);
    const avgCapex5 = hist5Values.length >= 2
      ? hist5Values.reduce((s, v) => s + v, 0) / hist5Values.length
      : null;
    const vs5yrAvgPct = avgCapex5 != null && capexCr != null
      ? Math.round(((capexCr - avgCapex5) / avgCapex5) * 100)
      : null;

    const slices = parts.map(p => ({
      name:         p.name,
      percentage:   Math.round((p.value / total) * 100),
      amount_label: formatCrLabel(p.value),
    }));

    const largest = slices.reduce((a, b) => a.percentage >= b.percentage ? a : b);

    return {
      total_deployed:         Math.round(total * 1e7), // Cr → rupees
      total_deployed_label:   formatCrLabel(total),
      vs_5yr_avg_pct:         vs5yrAvgPct,
      largest_allocation:     largest.name,
      largest_allocation_pct: largest.percentage,
      slices,
    };
  };

  // ── capex_breakdown: all 4 timeframes ────────────────────────────────────
  const capexBreakdown = {
    last_quarter: buildCapexBreakdown(1),
    '12_months':  buildCapexBreakdown(1),
    '3_years':    buildCapexBreakdown(3),
    '5_years':    buildCapexBreakdown(5),
  };

  // ── roce_trend ────────────────────────────────────────────────────────────
  const WACC_DEFAULT = 8; // assumed WACC threshold (%)

  // Yearly data points (chronological)
  const yearlyPoints = [];
  for (const fy of [...sortedFYs].reverse()) {
    const fyMap = toFyMap(byFY[fy] ?? []);
    const pbt = getCr(fyMap, 'PBT');
    const fin = getCr(fyMap, 'FIN_COST');
    const ta  = getCr(fyMap, 'TOTAL_ASSETS');
    const cl  = getCr(fyMap, 'CURR_LIAB');
    if (pbt == null || fin == null || ta == null || cl == null) continue;
    const ce = ta - cl;
    if (ce === 0) continue;
    const roce = parseFloat((((pbt + fin) / ce) * 100).toFixed(2));
    // period label: "FY2025" → "2025"
    const label = fy.replace('FY', '');
    yearlyPoints.push({ period: label, roce });
  }

  let roceTrend = null;

  if (yearlyPoints.length >= 2) {
    const first    = yearlyPoints[0].roce;
    const last     = yearlyPoints[yearlyPoints.length - 1].roce;
    const isRising = last > first;
    const diff     = parseFloat((last - first).toFixed(1));
    const years    = yearlyPoints.length - 1;

    const monotone = yearlyPoints.every((p, i) => i === 0 || p.roce >= yearlyPoints[i - 1].roce);
    let summary;
    if (yearlyPoints.length >= 3) {
      summary = monotone
        ? `ROCE improving consistently over ${years} year${years > 1 ? 's' : ''}`
        : isRising
          ? `ROCE generally improving over ${years} year${years > 1 ? 's' : ''} (+${diff}pp)`
          : `ROCE declining over ${years} year${years > 1 ? 's' : ''} (${diff}pp)`;
    } else {
      summary = isRising ? `ROCE up ${diff}pp YoY` : `ROCE down ${Math.abs(diff)}pp YoY`;
    }

    // Build shared metrics for both views
    const buildMetrics = (points) => {
      const latestRoce = points[points.length - 1].roce;
      const prevRoce   = points[points.length - 2]?.roce ?? null;
      const peakRoce   = Math.max(...points.map(p => p.roce));
      const peakPeriod = points.find(p => p.roce === peakRoce)?.period ?? '';
      const avgRoce    = parseFloat((points.reduce((s, p) => s + p.roce, 0) / points.length).toFixed(1));
      const vsWacc     = parseFloat((latestRoce - WACC_DEFAULT).toFixed(1));
      const yoyDiff    = prevRoce != null ? parseFloat((latestRoce - prevRoce).toFixed(1)) : null;

      return [
        {
          label:     'Latest ROCE',
          value:     `${latestRoce}%`,
          sub_label: yoyDiff != null ? `${yoyDiff >= 0 ? '+' : ''}${yoyDiff}pp vs prior` : null,
          sentiment: yoyDiff == null ? 'neutral' : yoyDiff >= 0 ? 'positive' : 'negative',
        },
        {
          label:     'Peak ROCE',
          value:     `${peakRoce}%`,
          sub_label: peakPeriod ? `FY ${peakPeriod}` : null,
          sentiment: 'neutral',
        },
        {
          label:     'Avg ROCE',
          value:     `${avgRoce}%`,
          sub_label: 'period average',
          sentiment: 'neutral',
        },
        {
          label:     `vs WACC (${WACC_DEFAULT}%)`,
          value:     `${vsWacc >= 0 ? '+' : ''}${vsWacc}pp`,
          sub_label: vsWacc > 0 ? 'value-creating' : 'value-destructive',
          sentiment: vsWacc > 0 ? 'positive' : 'negative',
        },
      ];
    };

    const yearlyAvg = parseFloat((yearlyPoints.reduce((s, p) => s + p.roce, 0) / yearlyPoints.length).toFixed(1));
    const yearlyDateRange = yearlyPoints.length >= 2
      ? `${yearlyPoints[0].period} – ${yearlyPoints[yearlyPoints.length - 1].period}`
      : null;

    roceTrend = {
      summary,
      yearly: {
        date_range:      yearlyDateRange,
        wacc_threshold:  WACC_DEFAULT,
        period_avg_roce: yearlyAvg,
        data_points:     yearlyPoints,
        metrics:         buildMetrics(yearlyPoints),
      },
      // quarterly: null until quarterly Prowess data is available
      quarterly: null,
    };
  }

  return { capex_breakdown: capexBreakdown, roce_trend: roceTrend ?? null };
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

function buildGuidanceRecords(summaries, milestoneByCall, kpiValueLookup, latestKpiByAbbr, kpiValueLookupFallback, latestKpiByAbbrFallback, primarySource) {
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
      if (!match) return { value: null, source: null };
      if (match.current_value != null) return { value: match.current_value, source: 'transcript+ppt' };
      const abbr = kpiAbbr?.trim().toLowerCase();
      const key  = `${match.callId}:::${abbr}`;
      const pv   = kpiValueLookup.get(key);
      if (pv != null) return { value: pv, source: primarySource };
      const fv   = kpiValueLookupFallback.get(key);
      if (fv != null) return { value: fv, source: 'transcript+ppt' };
      return { value: null, source: null };
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

      const successResolved  = resolveKpiValue(successMatch, goal.kpi_abbr);
      const failureResolved  = resolveKpiValue(failureMatch, goal.kpi_abbr);
      const rawCurrentValue  = successResolved.value ?? failureResolved.value;
      const rawSource        = successResolved.value != null ? successResolved.source : failureResolved.source;
      const isDirectValue    = successMatch?.current_value != null || failureMatch?.current_value != null;
      const matchedValue     = isDirectValue
        ? normalizeActualUnit(goal.targeted_value, rawCurrentValue)
        : rawCurrentValue;

      let currentValue = matchedValue;
      let dataSource   = rawSource;
      if (currentValue == null) {
        const prowessVal = latestKpiByAbbr.get(goal.kpi_abbr?.trim().toLowerCase());
        if (prowessVal != null) {
          currentValue = prowessVal;
          dataSource   = primarySource;
        } else {
          const fallbackVal = latestKpiByAbbrFallback.get(goal.kpi_abbr?.trim().toLowerCase());
          if (fallbackVal != null) {
            currentValue = fallbackVal;
            dataSource   = 'transcript+ppt';
          }
        }
      }

      const deadlineIsFuture = goal.target_time && new Date(goal.target_time) > latestCoveredDate;
      const latestVariance    = currentValue != null ? calcVariance(goal.targeted_value, currentValue) : null;
      const successVariance   = successResolved.value != null ? calcVariance(goal.targeted_value, successResolved.value) : null;
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
        data_source:    dataSource,
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
        data_source:    'transcript+ppt',
      });
    }
  }

  const total          = achievedCount + missedCount + hiddenCount;
  const hitRate        = total > 0 ? Math.round((achievedCount / total) * 100) : 50;
  const weightedTotal  = weightedAchieved + weightedMissed + weightedHidden;
  const guidanceScore  = weightedTotal > 0 ? Math.round((weightedAchieved / weightedTotal) * 100) : 50;

  return { records, hiddenCount, achievedCount, missedCount, undisclosedMissCount, hitRate, guidanceScore };
}

// ─── Descriptor builders (concise, data-driven summary text for each factor) ─

function buildGuidanceDescriptor(hitRate, achievedCount, missedCount) {
  const total = achievedCount + missedCount;
  if (total === 0) return 'No trackable guidance yet';
  const pct = `${Math.round(hitRate)}% hit rate`;
  if (hitRate >= 60) return `${pct} — delivers on commitments`;
  if (hitRate >= 30) return `${pct} — over-optimistic on targets`;
  return `${pct} — frequent misses (${missedCount} of ${total})`;
}

function buildDisclosureDescriptor(transparencyScore, governanceSignals, disclosures) {
  const earlyCount = disclosures.filter(d => d.disclosure_timing === 'proactive').length;
  if (transparencyScore >= 70 && earlyCount > 0) return 'Proactively discloses bad news early';
  if (transparencyScore >= 70) return 'Transparent — no red flags in disclosures';
  if (governanceSignals.defensive_language) return 'Evasive language detected in calls';
  if (transparencyScore >= 50) return 'Adequate but reactive on disclosures';
  return 'Limited transparency — key risks under-reported';
}

function buildCapitalDescriptor(capitalScore, capitalAllocation) {
  const latestRoce = capitalAllocation?.roce_trend?.yearly?.data_points?.slice(-1)[0]?.roce;
  if (latestRoce != null && capitalScore >= 70) return `Disciplined, ROCE at ${latestRoce}%`;
  if (latestRoce != null && capitalScore >= 50) return `Adequate allocation, ROCE at ${latestRoce}%`;
  if (latestRoce != null) return `Unclear strategy, ROCE only ${latestRoce}%`;
  if (capitalScore >= 70) return 'Clear capital allocation strategy';
  if (capitalScore >= 50) return 'Adequate but lacks clarity on allocation';
  return 'No clear capital allocation framework';
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

  const latest            = summaries[summaries.length - 1];
  const governanceSignals = latest.governanceSignals ?? {};
  const disclosures       = normalizeDisclosures(latest.riskDisclosures ?? null);

  const milestoneAbbrs = [...new Set(rawMilestones.map(m => m.kpi_abbr))];
  const prowessMapping = resolveProwess(companyPrefix);
  let kpiValueRows = [];
  // Hoisted for use by computeCapitalAllocation later
  let prowessByFY = {};
  let prowessSortedFYs = [];

  if (prowessMapping) {
    // Always fetch source rows when prowess mapping exists (needed for capital_allocation even without milestones)
    const GROSS_PPE_ABBRS = ['ASSET_LAND_GRS', 'ASSET_PM_GRS'];
    const directRowsPromise = milestoneAbbrs.length > 0
      ? prisma.prowessValueNew.findMany({
          where:  { company: prowessMapping.prowessName, kpi_abbr: { in: milestoneAbbrs } },
          select: { callId: true, kpi_abbr: true, value: true, multiplier: true, fiscal_year: true },
        })
      : Promise.resolve([]);
    const [directRows, sourceRows] = await Promise.all([
      directRowsPromise,
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
    prowessByFY      = byFY;
    prowessSortedFYs = sortedFYs;
    const latestFY  = sortedFYs[0];
    const prevFY    = sortedFYs[1] ?? null;

    if (milestoneAbbrs.length > 0) {

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
    }
  } else if (milestoneAbbrs.length > 0) {
    kpiValueRows = await prisma.kpiValue.findMany({
      where:  { company: companyPrefix, kpi_abbr: { in: milestoneAbbrs } },
      select: { callId: true, kpi_abbr: true, value: true },
    });
  }

  // Fetch kpi_values as fallback when prowess is primary (to fill gaps)
  const primarySource = prowessMapping ? 'financialData' : 'transcript+ppt';
  let kpiValueFallbackRows = [];
  if (prowessMapping && milestoneAbbrs.length > 0) {
    kpiValueFallbackRows = await prisma.kpiValue.findMany({
      where:  { company: companyPrefix, kpi_abbr: { in: milestoneAbbrs } },
      select: { callId: true, kpi_abbr: true, value: true },
    });
  }

  const milestoneByCall         = groupMilestonesByCall(rawMilestones);
  const kpiValueLookup          = buildKpiValueLookup(kpiValueRows);
  const latestKpiByAbbr         = buildLatestKpiByAbbr(kpiValueRows);
  const kpiValueLookupFallback  = buildKpiValueLookup(kpiValueFallbackRows);
  const latestKpiByAbbrFallback = buildLatestKpiByAbbr(kpiValueFallbackRows);

  const { records, hiddenCount, achievedCount, missedCount, undisclosedMissCount, hitRate, guidanceScore } =
    buildGuidanceRecords(summaries, milestoneByCall, kpiValueLookup, latestKpiByAbbr, kpiValueLookupFallback, latestKpiByAbbrFallback, primarySource);

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

  const transparencyScore = calculateTransparencyScore(governanceSignals, disclosures, undisclosedMissCount);
  const capitalScore      = calculateCapitalAllocationScore(governanceSignals);
  const overallScore      = calculateOverallScore(transparencyScore, guidanceScore, capitalScore);

  // Group all records (incl. HIDDEN) by status for hover lists on governance signal items
  const targetsByStatus = {};
  for (const r of mappedAll) {
    (targetsByStatus[r.status] ??= []).push({ metric: r.metric, statement: r.statement, period: r.period, targeted_value: r.targeted_value, current_value: r.current_value });
  }

  const proactiveDisclosures = disclosures.filter(d => d.disclosure_timing === 'proactive');

  const governanceSignalsArray = [];
  let sigId = 1;
  if (governanceSignals.transparent) {
    if (proactiveDisclosures.length > 0)
      governanceSignalsArray.push({ id: String(sigId++), text: `${proactiveDisclosures.length} disclosure(s) made proactively`, isPositive: true, risks: proactiveDisclosures.map(d => ({ risk: d.disclosure_title, severity: d.severity ?? null, mitigation: d.mitigation_strategy ?? null })) });
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

  const notablePatterns = disclosures.map((d, i) => ({
    id:          `disclosure-${i}`,
    title:       d.disclosure_title,
    description: d.disclosure_timing === 'proactive' ? 'Disclosed proactively' : 'Disclosed when pressed',
    category:    d.severity === 'high' ? 'negative' : d.severity === 'low' ? 'positive' : 'neutral',
  }));

  const capitalAllocation = computeCapitalAllocation(prowessByFY, prowessSortedFYs);

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
      { factor: 'Guidance Accuracy',  rating: getRating(guidanceScore),     descriptor: buildGuidanceDescriptor(hitRate, achievedCount, missedCount) },
      { factor: 'Disclosure Honesty', rating: getRating(transparencyScore),  descriptor: buildDisclosureDescriptor(transparencyScore, governanceSignals, disclosures) },
      { factor: 'Capital Allocation', rating: getRating(capitalScore),       descriptor: buildCapitalDescriptor(capitalScore, capitalAllocation) },
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
      disclosurePattern: governanceSignals.transparent && proactiveDisclosures.length > 0
        ? 'Early & Explicit'
        : governanceSignals.transparent ? 'Transparent' : 'Reactive',
    },
    guidanceRecords,
    disclosures,
    notablePatterns,
    selectedTimeframe: timeframe,
    capital_allocation: capitalAllocation,
  };
}

module.exports = { computeManagementAnalysis };
