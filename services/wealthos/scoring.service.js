'use strict';

// Expected risk score bands by risk profile (on a 0-10 scale)
const RISK_PROFILE_BAND = {
  conservative: 3,
  moderate:     5,
  aggressive:   8,
};

// Expected risk score by client segment (baseline)
const SEGMENT_RISK_BASELINE = {
  Retail:        3,
  HNI:           5,
  UHNI:          6,
  Institutional: 4,
  Private:       5,
};

/**
 * Compute a priority score for a client based on portfolio risk signals.
 * Formula (from PRD):
 *   score = 0.3 * drawdown + 0.2 * daysSinceContact + 0.2 * churnProbability + 0.3 * riskMismatch
 *
 * All components are normalized to [0, 1] before weighting.
 *
 * @param {object} client  - WealthClient record
 * @param {object|null} portfolio - WealthPortfolio record (may be null)
 * @returns {{ score: number, components: object, priority: 'HIGH'|'MEDIUM'|'LOW' }}
 */
function computePriorityScore(client, portfolio) {
  // ── Drawdown component ─────────────────────────────────────────────────────
  // Use portfolio.risk_score vs segment baseline. High risk score relative to
  // baseline suggests elevated portfolio risk / potential drawdown.
  let drawdown = 0;
  if (portfolio) {
    const baseline = SEGMENT_RISK_BASELINE[client.segment] ?? 5;
    drawdown = Math.min(Math.max((portfolio.risk_score - baseline) / 10, 0), 1);
  }

  // ── Days since contact component ───────────────────────────────────────────
  let daysSinceContact = 0;
  if (client.last_contact_at) {
    const msPerDay   = 1000 * 60 * 60 * 24;
    const days       = (Date.now() - new Date(client.last_contact_at).getTime()) / msPerDay;
    daysSinceContact = Math.min(days, 90) / 90;
  } else {
    // Never contacted — treat as maximum urgency on this component
    daysSinceContact = 1;
  }

  // ── Churn probability component ────────────────────────────────────────────
  const churnProbability = Math.min(Math.max(client.churn_probability ?? 0, 0), 1);

  // ── Risk mismatch component ────────────────────────────────────────────────
  // Compare portfolio risk_score to the expected band for the client's risk profile
  let riskMismatch = 0;
  if (portfolio) {
    const expected  = RISK_PROFILE_BAND[client.risk_profile] ?? 5;
    riskMismatch    = Math.min(Math.abs(portfolio.risk_score - expected) / 10, 1);
  }

  const score =
    0.3 * drawdown +
    0.2 * daysSinceContact +
    0.2 * churnProbability +
    0.3 * riskMismatch;

  const priority = score >= 0.6 ? 'HIGH' : score >= 0.35 ? 'MEDIUM' : 'LOW';

  return {
    score: Math.round(score * 1000) / 1000,
    components: {
      drawdown:         Math.round(drawdown * 1000) / 1000,
      daysSinceContact: Math.round(daysSinceContact * 1000) / 1000,
      churnProbability: Math.round(churnProbability * 1000) / 1000,
      riskMismatch:     Math.round(riskMismatch * 1000) / 1000,
    },
    priority,
  };
}

module.exports = { computePriorityScore };
