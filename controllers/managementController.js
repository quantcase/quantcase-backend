const prisma = require('../lib/prisma');

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
const calculateTransparencyScore = (governanceSignals, riskDisclosures) => {
  let score = 50;
  if (governanceSignals?.transparent) score += 35;
  if (!governanceSignals?.defensive_language) score += 15;
  const earlyDisclosures = Array.isArray(riskDisclosures)
    ? riskDisclosures.filter(r => r.disclosed_early).length : 0;
  if (earlyDisclosures > 0) score += Math.min(earlyDisclosures * 5, 20);
  return Math.min(score, 100);
};

const calculateCapitalAllocationScore = (governanceSignals) => {
  let score = 50;
  if (governanceSignals?.capital_allocation_clarity) score += 30;
  if (governanceSignals?.transparent) score += 20;
  return Math.min(score, 100);
};

const calculateOverallScore = (transparency, guidance, capital) =>
  Math.round(transparency * 0.4 + guidance * 0.35 + capital * 0.25);

const getOverallTrust = (score) =>
  score >= 80 ? "HIGH" : score >= 60 ? "MODERATE" : "LOW";

const getRating = (score) =>
  score >= 70 ? "HIGH" : score >= 50 ? "MODERATE" : "LOW";

const getConfidenceLevel = (confidence) =>
  confidence ? confidence.toUpperCase() : "MEDIUM";

// ─── Matching helpers ─────────────────────────────────────────────────────────

function matchTarget(goal, candidatePool, type) {
  if (type === 'financial') {
    return candidatePool.find(c => {
      if (c.kpi_abbr?.trim().toLowerCase() !== goal.kpi_abbr?.trim().toLowerCase()) return false;
      // Disclosure must have come after the goal was set but before/at deadline
      if (!c.target_time || !goal.target_time) return false;
      return new Date(c.target_time) < new Date(goal.target_time);
    }) ?? null;
  }

  // Conceptual
  return candidatePool.find(c => {
    const timeOk = c.target_time && goal.target_time
      ? new Date(c.target_time) < new Date(goal.target_time)
      : true; // if no dates, don't filter on time
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

// ─── Core guidance builder ────────────────────────────────────────────────────

/**
 * For each transcript except the latest, take its future_goals and try to
 * match them against success/failure disclosures in ALL subsequent transcripts.
 * Latest transcript's future goals are completely skipped (verdict still out).
 */
const GUIDANCE_TOLERANCE_PCT = 5; // within 5% of target counts as achieved

function buildGuidanceRecords(summaries) {
  const records = [];
  let recordId    = 0;
  let hiddenCount  = 0;
  let achievedCount = 0;
  let missedCount  = 0;

  // "Has a quarter passed" = we have a transcript for it or later
  const latestCallId = summaries[summaries.length - 1].callId;
  const { fiscalYear: latestFY, quarter: latestQ } = parseCallId(latestCallId);
  const latestCoveredDate = getQuarterEndDate(latestFY, latestQ) ?? new Date();

  const scorableSummaries = summaries.slice(0, summaries.length - 1);

  for (let i = 0; i < scorableSummaries.length; i++) {
    const source     = scorableSummaries[i];
    const subsequent = summaries.slice(i + 1);

    // Tag each disclosure with its source summary so we can fall back to kpis[]
    const allSuccessFinancial  = subsequent.flatMap(s => (s.milestones?.success_disclosures?.financial_targets  ?? []).map(t => ({ ...t, _summary: s })));
    const allSuccessConceptual = subsequent.flatMap(s => (s.milestones?.success_disclosures?.conceptual_targets ?? []).map(t => ({ ...t, _summary: s })));
    const allFailureFinancial  = subsequent.flatMap(s => (s.milestones?.failure_disclosures?.financial_targets  ?? []).map(t => ({ ...t, _summary: s })));
    const allFailureConceptual = subsequent.flatMap(s => (s.milestones?.failure_disclosures?.conceptual_targets ?? []).map(t => ({ ...t, _summary: s })));

    // If match.current_value is null, look up the value in the source summary's kpis[]
    const resolveKpiValue = (match, kpiAbbr) => {
      if (!match) return null;
      if (match.current_value != null) return match.current_value;
      const kpi = (match._summary?.kpis ?? []).find(
        k => k.kpi_abbr?.trim().toLowerCase() === kpiAbbr?.trim().toLowerCase()
      );
      return kpi?.value ?? null;
    };

    // ── Financial ──
    for (const goal of (source.milestones?.future_goals?.financial_targets ?? [])) {
      const successMatch = matchTarget(goal, allSuccessFinancial, 'financial');
      const failureMatch = matchTarget(goal, allFailureFinancial, 'financial');

      const hasFutureCandidate = [...allSuccessFinancial, ...allFailureFinancial].some(c =>
        c.kpi_abbr?.trim().toLowerCase() === goal.kpi_abbr?.trim().toLowerCase() &&
        c.target_time && goal.target_time &&
        new Date(c.target_time) >= new Date(goal.target_time)
      );

      // Resolve current_value: try match field first, then fall back to kpis[] in the source summary
      const successValue = resolveKpiValue(successMatch, goal.kpi_abbr);
      const failureValue = resolveKpiValue(failureMatch, goal.kpi_abbr);
      const currentValue = successValue ?? failureValue;

      // Deadline is "in the future" if we don't yet have a transcript covering that quarter
      const deadlineIsFuture = goal.target_time && new Date(goal.target_time) > latestCoveredDate;
      // Only compute variance when we actually have a value (null short-circuit was a bug)
      const successVariance   = successValue != null ? calcVariance(goal.targeted_value, successValue) : null;
      // Within tolerance band counts as achieved (e.g. -3% on a 296194 target is fine)
      const targetActuallyMet = successMatch && successVariance !== null && successVariance >= -GUIDANCE_TOLERANCE_PCT;

      let status;
      if      (targetActuallyMet)                                   status = 'ACHIEVED';
      else if (failureMatch || (successMatch && !deadlineIsFuture)) status = 'MISSED';
      else if (deadlineIsFuture || hasFutureCandidate)              status = 'PENDING';
      else                                                          status = 'HIDDEN';

      // If we have a match but couldn't find a numeric value anywhere, flag it
      if ((status === 'ACHIEVED' || status === 'MISSED') && currentValue === null) {
        status = 'KPI_MATCHING_NOT_FOUND';
      }

      if      (status === 'ACHIEVED') achievedCount++;
      else if (status === 'MISSED')   missedCount++;
      else if (status === 'HIDDEN')   hiddenCount++;

      records.push({
        id:             `guidance-${recordId++}`,
        source_call:    source.callId,
        source_date:    source.callDate,
        period:         goal.target_time    ?? 'TBD',
        metric:         goal.kpi_abbr       ?? '',
        statement:      goal.statement,
        targeted_value: goal.targeted_value ?? null,
        current_value:  currentValue,
        variance_pct:   status === 'ACHIEVED' || status === 'MISSED'
                          ? calcVariance(goal.targeted_value, currentValue)
                          : null,
        status,
        target_type:    'financial'
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

      if      (status === 'ACHIEVED') achievedCount++;
      else if (status === 'MISSED')   missedCount++;
      else if (status === 'HIDDEN')   hiddenCount++;

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
        status,
        target_type:    'conceptual'
      });
    }
  }

  const total         = achievedCount + missedCount + hiddenCount;
  const hitRate       = total > 0 ? Math.round((achievedCount / total) * 100) : 50;
  const guidanceScore = total > 0 ? Math.round((achievedCount / total) * 100) : 50;

  return { records, hiddenCount, achievedCount, missedCount, hitRate, guidanceScore };
}

// ─── Controller ───────────────────────────────────────────────────────────────

const getManagementAnalysis = async (req, res) => {
  try {
    const { callId, timeframe = 'rolling_3_year' } = req.query;

    if (!callId) {
      return res.status(400).json({ success: false, error: 'callId is required' });
    }

    // Fetch the requested call to get company identifier
   // Extract company prefix from callId (e.g. "ADANIENSOL" from "ADANIENSOL_FY2026_Q3")
const companyPrefix = callId.split('_FY')[0];

const rawSummaries = await prisma.summary.findMany({
  where:   { callId: { startsWith: companyPrefix } },
  orderBy: { createdAt: 'desc' },
  take:    3
});

if (rawSummaries.length === 0) {
  return res.status(404).json({ success: false, error: 'No summaries found for this company' });
}

// Sort oldest → newest using callId parsing
const summaries = rawSummaries
  .map(s => ({ ...s, callDate: s.createdAt }))
  .sort((a, b) => {
    const pa = parseCallId(a.callId);
    const pb = parseCallId(b.callId);
    if (pa.fiscalYear !== pb.fiscalYear) return pa.fiscalYear - pb.fiscalYear;
    return pa.quarter - pb.quarter;
  });

console.log('Sorted summaries:', summaries.map(s => s.callId));
    const latest          = summaries[summaries.length - 1];
    const governanceSignals = latest.governanceSignals ?? {};
    const riskDisclosures  = Array.isArray(latest.riskDisclosures) ? latest.riskDisclosures : [];

    // ── Cross-transcript guidance accuracy ───────────────────────────────────
    const { records, hiddenCount, achievedCount, missedCount, hitRate, guidanceScore } =
      buildGuidanceRecords(summaries);

    // ── Scores ───────────────────────────────────────────────────────────────
    const transparencyScore = calculateTransparencyScore(governanceSignals, riskDisclosures);
    const capitalScore      = calculateCapitalAllocationScore(governanceSignals);
    const overallScore      = calculateOverallScore(transparencyScore, guidanceScore, capitalScore);

    // ── Governance signal pills ───────────────────────────────────────────────
    const governanceSignalsArray = [];
    let sigId = 1;

    if (governanceSignals.transparent) {
      const early = riskDisclosures.filter(r => r.disclosed_early);
      if (early.length > 0)
        governanceSignalsArray.push({ id: String(sigId++), text: `${early.length} risk(s) disclosed proactively`, isPositive: true });
      governanceSignalsArray.push({ id: String(sigId++), text: "Management demonstrates transparency", isPositive: true });
    }
    if (governanceSignals.capital_allocation_clarity)
      governanceSignalsArray.push({ id: String(sigId++), text: "Clear capital allocation strategy communicated", isPositive: true });
    if (governanceSignals.defensive_language)
      governanceSignalsArray.push({ id: String(sigId++), text: "Defensive or evasive language detected", isPositive: false });
    if (achievedCount > 0)
      governanceSignalsArray.push({ id: String(sigId++), text: `${achievedCount} past target(s) achieved`, isPositive: true });
    if (missedCount > 0)
      governanceSignalsArray.push({ id: String(sigId++), text: `${missedCount} past target(s) missed`, isPositive: false });
    if (hiddenCount > 0)
      governanceSignalsArray.push({ id: String(sigId++), text: `${hiddenCount} past target(s) never revisited`, isPositive: false });

    // ── Notable patterns ──────────────────────────────────────────────────────
    const notablePatterns = riskDisclosures.map((risk, i) => ({
      id:          `risk-${i}`,
      title:       risk.risk,
      description: risk.disclosed_early ? "Disclosed proactively" : "Disclosed when pressed",
      category:    risk.severity === 'high' ? 'negative' : risk.severity === 'low' ? 'positive' : 'neutral'
    }));

    res.json({
      success: true,
      data: {
        company: {
          name:               latest.callId,
         // ticker:             call.company_name ?? call.company ?? null,
          exchange:           "NSE",
          industry:           latest.entities?.business_segments?.join(', ') ?? null,
 //         callDate:           call.call_date ?? null,
          confidenceLevel:    getConfidenceLevel(latest.confidence),
          transcriptsAnalyzed: summaries.length
        },
        scores: [
          {
            factor:     "Guidance Accuracy",
            rating:     getRating(guidanceScore),
            descriptor: hitRate >= 75 ? "Consistent Delivery" : hitRate >= 50 ? "Mixed Track Record" : "Inconsistent"
          },
          {
            factor:     "Disclosure Honesty",
            rating:     getRating(transparencyScore),
            descriptor: transparencyScore >= 70 ? "Transparent Ops" : transparencyScore >= 50 ? "Adequate Disclosure" : "Limited Transparency"
          },
          {
            factor:     "Capital Allocation",
            rating:     getRating(capitalScore),
            descriptor: capitalScore >= 70 ? "Value Accretive" : capitalScore >= 50 ? "Adequate Strategy" : "Unclear Direction"
          }
        ],
        trust: {
          overall: getOverallTrust(overallScore),
          subfactors: {
            guidanceAccuracy:  guidanceScore,
            disclosureHonesty: transparencyScore,
            capitalAllocation: capitalScore
          }
        },
        governanceSignals: governanceSignalsArray,
        consistency: {
          score:            Math.min(overallScore / 25, 4.0),
          maxScore:         4.0,
          hitRate,
          hiddenCount,
          disclosurePattern: governanceSignals.transparent && riskDisclosures.some(r => r.disclosed_early)
            ? "Early & Explicit"
            : governanceSignals.transparent ? "Transparent" : "Reactive"
        },
        guidanceRecords: records,
        notablePatterns,
        selectedTimeframe: timeframe
      }
    });

  } catch (error) {
    console.error('Error in getManagementAnalysis:', error);
    res.status(500).json({
      success: false,
      error:   'Internal server error',
      message: error.message
    });
  }
};

module.exports = { getManagementAnalysis };