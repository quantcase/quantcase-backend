const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Calculate transparency score based on governance signals and risk disclosures
 */
const calculateTransparencyScore = (governanceSignals, riskDisclosures) => {
  let score = 50; // Base score

  if (governanceSignals?.transparent) score += 35;
  if (!governanceSignals?.defensive_language) score += 15;

  // Bonus for early risk disclosure
  const earlyDisclosures = Array.isArray(riskDisclosures)
    ? riskDisclosures.filter(r => r.disclosed_early).length
    : 0;
  if (earlyDisclosures > 0) score += Math.min(earlyDisclosures * 5, 20);

  return Math.min(score, 100);
};

/**
 * Calculate guidance accuracy score based on milestones
 */
const calculateGuidanceAccuracy = (milestones) => {
  if (!milestones) return 50;

  const successes = (milestones.success_disclosures?.financial_targets?.length || 0) +
                    (milestones.success_disclosures?.conceptual_targets?.length || 0);
  const failures = (milestones.failure_disclosures?.financial_targets?.length || 0) +
                   (milestones.failure_disclosures?.conceptual_targets?.length || 0);

  if (successes + failures === 0) return 50; // No data

  const hitRate = (successes / (successes + failures)) * 100;
  return Math.round(hitRate);
};

/**
 * Calculate capital allocation score
 */
const calculateCapitalAllocationScore = (governanceSignals) => {
  let score = 50; // Base score

  if (governanceSignals?.capital_allocation_clarity) score += 30;
  if (governanceSignals?.transparent) score += 20;

  return Math.min(score, 100);
};

/**
 * Calculate overall management score
 */
const calculateOverallScore = (transparency, guidance, capital) => {
  // Weighted average: transparency 40%, guidance 35%, capital 25%
  return Math.round(transparency * 0.4 + guidance * 0.35 + capital * 0.25);
};

/**
 * Determine overall trust level based on score
 */
const getOverallTrust = (score) => {
  if (score >= 80) return "HIGH";
  if (score >= 60) return "MODERATE";
  return "LOW";
};

/**
 * Get confidence level from summary
 */
const getConfidenceLevel = (confidence) => {
  if (!confidence) return "MEDIUM";
  return typeof confidence === 'string' ? confidence.toUpperCase() : "MEDIUM";
};

/**
 * Get management analysis for a specific earnings call
 * Query params: callId (required), timeframe (optional, default: 'rolling_3_year')
 */
const getManagementAnalysis = async (req, res) => {
  try {
    const { callId, timeframe = 'rolling_3_year' } = req.query;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'callId query parameter is required'
      });
    }

    // Fetch the earnings call
    const call = await prisma.earnings_calls.findUnique({
      where: { id: callId }
    });

    if (!call) {
      return res.status(400).json({
        success: false,
        error: 'Analysis not found'
      });
    }

    // Find the most recent summary for this call
    const summary = await prisma.summary.findFirst({
      where: { callId: callId },
      orderBy: { createdAt: 'desc' }
    });

    if (!summary) {
      return res.status(400).json({
        success: false,
        error: 'Analysis not found for this call'
      });
    }

    // Extract data from summary
    const governanceSignals = summary.governanceSignals || {};
    const riskDisclosures = Array.isArray(summary.riskDisclosures) ? summary.riskDisclosures : [];
    const milestones = summary.milestones || {};

    // Calculate scores
    const transparencyScore = calculateTransparencyScore(governanceSignals, riskDisclosures);
    const guidanceScore = calculateGuidanceAccuracy(milestones);
    const capitalScore = calculateCapitalAllocationScore(governanceSignals);
    const overallScore = calculateOverallScore(transparencyScore, guidanceScore, capitalScore);
    const overallTrust = getOverallTrust(overallScore);

    // Determine ratings
    const transparencyRating = transparencyScore >= 70 ? "HIGH" : transparencyScore >= 50 ? "MODERATE" : "LOW";
    const guidanceRating = guidanceScore >= 70 ? "HIGH" : guidanceScore >= 50 ? "MODERATE" : "LOW";
    const capitalRating = capitalScore >= 70 ? "HIGH" : capitalScore >= 50 ? "MODERATE" : "LOW";

    // Map guidance records from all sources (future goals, successes, failures)
    const guidanceRecords = [];
    let recordId = 0;

    // Add success disclosures (ACHIEVED status)
    const successFinancial = (milestones.success_disclosures?.financial_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "Past",
      metric: target.metric_name || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Achieved",
      variance: "-",
      status: "ACHIEVED",
      target_type: "financial"
    }));

    const successConceptual = (milestones.success_disclosures?.conceptual_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "Past",
      metric: target.statement || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Achieved",
      variance: "-",
      status: "ACHIEVED",
      target_type: "conceptual"
    }));

    // Add failure disclosures (MISSED status)
    const failureFinancial = (milestones.failure_disclosures?.financial_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "Past",
      metric: target.metric_name || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Missed",
      variance: "-",
      status: "MISSED",
      target_type: "financial"
    }));

    const failureConceptual = (milestones.failure_disclosures?.conceptual_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "Past",
      metric: target.statement || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Missed",
      variance: "-",
      status: "MISSED",
      target_type: "conceptual"
    }));

    // Add future goals (PENDING status)
    const futureFinancial = (milestones.future_goals?.financial_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "TBD",
      metric: target.metric_name || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Pending",
      variance: "-",
      status: "PENDING",
      target_type: "financial"
    }));

    const futureConceptual = (milestones.future_goals?.conceptual_targets || []).map(target => ({
      id: `guidance-${recordId++}`,
      period: target.targetTime || "TBD",
      metric: target.statement || "",
      targeted_value: target.targeted_value || "",
      current_value: target.current_value || "Pending",
      variance: "-",
      status: "PENDING",
      target_type: "conceptual"
    }));

    // Combine all guidance records
    guidanceRecords.push(
      ...successFinancial,
      ...successConceptual,
      ...failureFinancial,
      ...failureConceptual,
      ...futureFinancial,
      ...futureConceptual
    );

    // Map risk disclosures to notable patterns
    const mappedNotablePatterns = riskDisclosures.map((risk, index) => {
      let category = "neutral";
      if (risk.severity === "high") category = "negative";
      else if (risk.severity === "low") category = "positive";

      return {
        id: `risk-${index}`,
        title: risk.risk || "",
        description: risk.disclosed_early ? "Disclosed early in the call" : "Disclosed when questioned",
        category
      };
    });

    // Calculate success/failure counts for milestone tracking
    const successCount = (milestones.success_disclosures?.financial_targets?.length || 0) +
                        (milestones.success_disclosures?.conceptual_targets?.length || 0);
    const failureCount = (milestones.failure_disclosures?.financial_targets?.length || 0) +
                        (milestones.failure_disclosures?.conceptual_targets?.length || 0);
    const hitRate = successCount + failureCount > 0
      ? Math.round((successCount / (successCount + failureCount)) * 100)
      : 0;

    // Build governance signals array based on actual data
    const governanceSignalsArray = [];
    let signalId = 1;

    // Transparency signals
    if (governanceSignals.transparent) {
      const earlyDisclosures = riskDisclosures.filter(r => r.disclosed_early);
      if (earlyDisclosures.length > 0) {
        governanceSignalsArray.push({
          id: String(signalId++),
          text: `${earlyDisclosures.length} risk(s) disclosed early and explicitly`,
          isPositive: true
        });
      }
      governanceSignalsArray.push({
        id: String(signalId++),
        text: "Management demonstrates transparency in communications",
        isPositive: true
      });
    }

    // Capital allocation signals
    if (governanceSignals.capital_allocation_clarity) {
      governanceSignalsArray.push({
        id: String(signalId++),
        text: "Clear capital allocation strategy communicated",
        isPositive: true
      });
    }

    // Defensive language warning
    if (governanceSignals.defensive_language) {
      governanceSignalsArray.push({
        id: String(signalId++),
        text: "Defensive or evasive language detected in responses",
        isPositive: false
      });
    }

    // Milestone tracking signals
    if (successCount > 0) {
      governanceSignalsArray.push({
        id: String(signalId++),
        text: `${successCount} previously announced target(s) achieved`,
        isPositive: true
      });
    }
    if (failureCount > 0) {
      governanceSignalsArray.push({
        id: String(signalId++),
        text: `${failureCount} previously announced target(s) missed`,
        isPositive: false
      });
    }

    // Build response
    const response = {
      company: {
        name: summary.callId,
        ticker: call.company_name || call.company || null,
        exchange: "NSE",
        industry: summary.entities?.business_segments?.join(', ') || null,
        callDate: call.call_date || null,
        confidenceLevel: getConfidenceLevel(summary.confidence)
      },
      scores: [
        {
          factor: "Guidance Accuracy",
          rating: guidanceRating,
          descriptor: hitRate >= 75 ? "Consistent Delivery" : hitRate >= 50 ? "Mixed Track Record" : "Inconsistent"
        },
        {
          factor: "Disclosure Honesty",
          rating: transparencyRating,
          descriptor: transparencyScore >= 70 ? "Transparent Ops" : transparencyScore >= 50 ? "Adequate Disclosure" : "Limited Transparency"
        },
        {
          factor: "Capital Allocation",
          rating: capitalRating,
          descriptor: capitalScore >= 70 ? "Value Accretive" : capitalScore >= 50 ? "Adequate Strategy" : "Unclear Direction"
        }
      ],
      trust: {
        overall: overallTrust,
        subfactors: {
          guidanceAccuracy: guidanceScore,
          disclosureHonesty: transparencyScore,
          capitalAllocation: capitalScore
        }
      },
      governanceSignals: governanceSignalsArray,
      consistency: {
        score: Math.min(overallScore / 25, 4.0), // Convert 0-100 to 0-4 scale
        maxScore: 4.0,
        hitRate: hitRate,
        disclosurePattern: governanceSignals.transparent && riskDisclosures.some(r => r.disclosed_early)
          ? "Early & Explicit"
          : governanceSignals.transparent
          ? "Transparent"
          : "Reactive"
      },
      guidanceRecords,
      notablePatterns: mappedNotablePatterns,
      selectedTimeframe: timeframe
    };
    res.json({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Error fetching management analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch management analysis',
      message: error.message
    });
  }
};

module.exports = {
  getManagementAnalysis
};
