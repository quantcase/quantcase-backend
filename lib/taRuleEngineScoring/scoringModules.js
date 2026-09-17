'use strict';

/**
 * Modules 1–7 Scoring Tables
 *
 * Implements §4 of technical-analysis-scoring-design-spec.md.
 * Pure deterministic arithmetic and decision tables.
 */

// ─── Module 1: Structure / Wyckoff + S/R (20 pts) ────────────────────────────

function scoreModule1(inputs, dataGaps = []) {
  let phase = (inputs.wyckoff_phase || '').toUpperCase();
  const cmfSignal = (inputs.cmf_signal || '').toUpperCase();
  const stockVsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const rsiZone = inputs.rsi_zone || '';
  const srZone = inputs.sr_zone || 'Mid Range';
  const supportStrength = inputs.sr_support_strength || '';
  const resistanceProximityPct = inputs.sr_resistance_proximity_pct;

  let phaseRelabelled = false;

  // Ambiguity resolution (apply BEFORE scoring)
  if (
    phase === 'DISTRIBUTION' &&
    cmfSignal === 'POSITIVE' &&
    stockVsNifty === 'OUTPERFORMING' &&
    rsiZone === '50-70'
  ) {
    phase = 'RE-ACCUMULATION';
    phaseRelabelled = true;
  } else if (
    phase === 'RE-DISTRIBUTION' &&
    cmfSignal === 'POSITIVE' &&
    stockVsNifty === 'OUTPERFORMING'
  ) {
    phase = 'ACCUMULATION';
    phaseRelabelled = true;
  }

  // Step 1: Base score
  let baseScore = 0;
  if (phase === 'MARK-UP' || phase === 'MARKUP') {
    baseScore = 14;
  } else if (phase === 'RE-ACCUMULATION') {
    baseScore = 12;
  } else if (phase === 'ACCUMULATION') {
    baseScore = 11;
  } else if (phase === 'RE-DISTRIBUTION') {
    baseScore = 6;
  } else if (phase === 'DISTRIBUTION') {
    baseScore = 4;
  } else if (phase === 'MARKDOWN') {
    baseScore = 0;
  } else {
    baseScore = 6;
    dataGaps.push(`Unrecognized Wyckoff phase "${phase}" for Module 1 base score`);
  }

  // Step 2: S/R zone modifier
  let zoneMod = 0;
  if (srZone === 'At Support') {
    zoneMod = 6;
  } else if (srZone === 'Approaching Support') {
    zoneMod = 4;
  } else if (srZone === 'Confirmed Breakout') {
    zoneMod = 3;
  } else if (srZone === 'Mid Range') {
    zoneMod = 1;
  } else if (srZone === 'Approaching Resistance') {
    zoneMod = 0;
  } else if (srZone === 'At Resistance') {
    zoneMod = 0;
  } else if (srZone === 'Breakdown') {
    zoneMod = -3;
  } else {
    zoneMod = 1;
    dataGaps.push(`Unrecognized S/R zone "${srZone}" in Module 1`);
  }

  // Step 3: S/R strength modifier
  let strengthMod = 0;
  if (typeof supportStrength === 'string' && supportStrength.toUpperCase().includes('HIGH')) {
    strengthMod = 2;
  } else if (
    srZone === 'At Resistance' &&
    resistanceProximityPct != null &&
    !isNaN(resistanceProximityPct) &&
    parseFloat(resistanceProximityPct) < 2
  ) {
    strengthMod = -2;
  } else if (typeof supportStrength === 'string' && supportStrength.toUpperCase().includes('LOW')) {
    strengthMod = -1;
  }

  const rawScore = baseScore + zoneMod + strengthMod;
  const score = Math.max(0, Math.min(20, rawScore));

  return {
    score,
    baseScore,
    zoneMod,
    strengthMod,
    resolvedPhase: phase,
    phaseRelabelled,
  };
}

// ─── Module 2: Trend / SMA Regime (20 pts) ───────────────────────────────────

function scoreModule2(inputs, stockType, dataGaps = []) {
  const {
    price_vs_sma20,
    price_vs_sma50,
    price_vs_sma100,
    price_vs_sma200,
    sma50_slope,
    valid_confirmed_cross_above_sma200,
    price_vs_sma200_pct,
    price_vs_sma100_pct,
  } = inputs;

  const above20  = price_vs_sma20  === 'ABOVE';
  const above50  = price_vs_sma50  === 'ABOVE';
  const above100 = price_vs_sma100 === 'ABOVE';
  const above200 = price_vs_sma200 === 'ABOVE';

  const validCross = valid_confirmed_cross_above_sma200 === true || valid_confirmed_cross_above_sma200 === 'true';
  const crossIsNA  = valid_confirmed_cross_above_sma200 == null ||
                     valid_confirmed_cross_above_sma200 === 'N/A' ||
                     typeof valid_confirmed_cross_above_sma200 === 'string' && valid_confirmed_cross_above_sma200.startsWith('N/A');

  if (crossIsNA) {
    dataGaps.push('Valid confirmed SMA_200 cross is N/A; used highest non-cross match');
  }

  const dist200 = price_vs_sma200_pct != null ? parseFloat(price_vs_sma200_pct) : null;
  const dist100 = price_vs_sma100_pct != null ? parseFloat(price_vs_sma100_pct) : null;
  const slopeRising = sma50_slope === 'Rising';

  let baseScore = 0;

  if (stockType === 'Growth') {
    if (validCross && !crossIsNA) {
      baseScore = 18;
    } else if (above200 && above100 && !above50) {
      baseScore = 16;
    } else if (above200 && above100 && above50 && !above20) {
      baseScore = 13;
    } else if (above200 && above100 && above50 && above20) {
      baseScore = 10;
    } else if (!above200 && above100) {
      baseScore = 5;
    } else if (!above200 && !above100 && (above50 || above20)) {
      baseScore = 2;
    } else if (!above200 && !above100 && !above50 && !above20) {
      baseScore = 0;
    } else if (above200) {
      baseScore = 13; // fallback when above 200
    } else {
      baseScore = 2;
    }
  } else {
    // Value (all non-Growth, including ties)
    // Returning to SMA_200 from above (within 3%, SMA_50 slope Rising) -> 18
    const returningTo200 = above200 && dist200 != null && dist200 >= 0 && dist200 <= 3 && slopeRising;

    if (returningTo200) {
      baseScore = 18;
    } else if (validCross && !crossIsNA) {
      baseScore = 16;
    } else if (above200 && dist100 != null && Math.abs(dist100) <= 5) {
      baseScore = 13;
    } else if (above200 && above100 && above50) {
      baseScore = 10;
    } else if (above200 && dist200 != null && dist200 > 15) {
      baseScore = 7;
    } else if (!above200 && above100) {
      baseScore = 8;
    } else if (!above200 && !above100 && !above50 && !above20) {
      baseScore = 2;
    } else if (above200) {
      baseScore = 10;
    } else {
      baseScore = 2;
    }
  }

  // Slope modifier (all types): SMA_50 Slope Rising -> +1 | Falling -> -1
  let slopeMod = 0;
  if (sma50_slope === 'Rising') {
    slopeMod = 1;
  } else if (sma50_slope === 'Falling') {
    slopeMod = -1;
  }

  const score = Math.max(0, Math.min(20, baseScore + slopeMod));
  return { score, baseScore, slopeMod };
}

// ─── Module 3: Momentum / RSI (15 pts) ───────────────────────────────────────

/**
 * Ordered list of (zone, direction, priceVsSMA100, bbwDirection) -> score.
 * First match wins. 'Any' acts as wildcard.
 */
const M3_GROWTH_RULES = [
  ['50-70',  'RISING',  'ABOVE', 'ANY',     15],
  ['70-100', 'RISING',  'ABOVE', 'RISING',  13],
  ['50-70',  'RISING',  'ABOVE', 'FALLING', 12],
  ['70-100', 'RISING',  'ABOVE', 'FALLING', 10],
  ['50-70',  'FALLING', 'ABOVE', 'ANY',      8],
  ['30-50',  'RISING',  'ABOVE', 'ANY',      7],
  ['70-100', 'FALLING', 'ANY',   'ANY',      5],
  ['0-30',   'RISING',  'ABOVE', 'ANY',      4],
  ['30-50',  'RISING',  'BELOW', 'ANY',      4],
  ['30-50',  'FALLING', 'ANY',   'ANY',      3],
  ['0-30',   'RISING',  'BELOW', 'ANY',      2],
  ['0-30',   'FALLING', 'ANY',   'ANY',      0],
];

const M3_VALUE_RULES = [
  ['30-50',  'RISING',  'ABOVE', 'ANY',     15],
  ['0-30',   'RISING',  'ABOVE', 'FALLING', 13],
  ['30-50',  'RISING',  'BELOW', 'ANY',     11],
  ['50-70',  'RISING',  'ABOVE', 'ANY',     10],
  ['0-30',   'RISING',  'BELOW', 'ANY',      8],
  ['30-50',  'FALLING', 'ABOVE', 'ANY',      7],
  ['50-70',  'FALLING', 'ABOVE', 'ANY',      6],
  ['0-30',   'FALLING', 'ABOVE', 'ANY',      5],
  ['70-100', 'ANY',     'ANY',   'ANY',      3],
  ['0-30',   'FALLING', 'BELOW', 'ANY',      1],
];

const M3_MIXED_RULES = [
  ['50-70',  'RISING',  'ABOVE', 'ANY',     15],
  ['50-70',  'RISING',  'ABOVE', 'FALLING', 12],
  ['30-50',  'RISING',  'ABOVE', 'ANY',     12],
  ['0-30',   'RISING',  'ABOVE', 'FALLING', 10],
  ['70-100', 'RISING',  'ABOVE', 'RISING',   9],
  ['50-70',  'FALLING', 'ABOVE', 'ANY',      8],
  ['30-50',  'FALLING', 'ABOVE', 'ANY',      6],
  ['0-30',   'RISING',  'BELOW', 'ANY',      5],
  ['70-100', 'FALLING', 'ANY',   'ANY',      4],
  ['0-30',   'FALLING', 'ANY',   'ANY',      1],
];

function scoreModule3(inputs, stockType, dataGaps = []) {
  const rsiZone = inputs.rsi_zone || '30-50';
  const rsiDir  = (inputs.rsi_direction || 'RISING').toUpperCase();
  const smaPos  = (inputs.price_vs_sma100 || 'ABOVE').toUpperCase();
  const bbwDir  = (inputs.bbw_direction || 'RISING').toUpperCase();

  const rules = stockType === 'Growth' ? M3_GROWTH_RULES : M3_VALUE_RULES;

  for (const [z, d, s, b, score] of rules) {
    const matchZ = z === 'ANY' || z === rsiZone;
    const matchD = d === 'ANY' || d === rsiDir;
    const matchS = s === 'ANY' || s === smaPos;
    const matchB = b === 'ANY' || b === bbwDir;

    if (matchZ && matchD && matchS && matchB) {
      return { score, matchedRule: [z, d, s, b] };
    }
  }

  // Fallback if no specific rule hit
  return { score: 5, matchedRule: ['DEFAULT'] };
}

// ─── Module 4: Trend Maturity / ADX (15 pts) ─────────────────────────────────

const M4_RULES = [
  ['15-25',  'RISING',  'ABOVE', 15],
  ['25-50',  'RISING',  'ABOVE', 13],
  ['15-25',  'RISING',  'BELOW', 11],
  ['0-15',   'RISING',  'ABOVE',  9],
  ['25-50',  'FALLING', 'ABOVE',  8],
  ['15-25',  'FALLING', 'ABOVE',  6],
  ['0-15',   'FALLING', 'ANY',    5],
  ['50-70',  'RISING',  'ABOVE',  4],
  ['25-50',  'ANY',     'BELOW',  3],
  ['50-70',  'FALLING', 'ANY',    2],
  ['70-100', 'RISING',  'ANY',    1],
  ['70-100', 'FALLING', 'ANY',    0],
];

function scoreModule4(inputs, dataGaps = []) {
  const adxZone = inputs.adx_zone || '15-25';
  let adxDir = (inputs.adx_direction || 'RISING').toUpperCase();
  if (adxDir === 'FLAT') adxDir = 'FALLING'; // spec: FLAT treated as Falling

  const smaPos = (inputs.price_vs_sma100 || 'ABOVE').toUpperCase();

  for (const [z, d, s, score] of M4_RULES) {
    const matchZ = z === 'ANY' || z === adxZone;
    const matchD = d === 'ANY' || d === adxDir;
    const matchS = s === 'ANY' || s === smaPos;

    if (matchZ && matchD && matchS) {
      return { score, matchedRule: [z, d, s] };
    }
  }

  return { score: 4, matchedRule: ['DEFAULT'] };
}

// ─── Module 5: Leadership / RS (15 pts) ──────────────────────────────────────

const M5_LOOKUP = {
  'OUT|OUT|OUT':     15,
  'OUT|OUT|UNDER':   12,
  'OUT|UNDER|OUT':    8,
  'UNDER|OUT|UNDER':  6,
  'OUT|UNDER|UNDER':  5,
  'UNDER|OUT|OUT':    4,
  'UNDER|UNDER|OUT':  3,
  'UNDER|UNDER|UNDER': 0,
};

function scoreModule5(inputs, dataGaps = []) {
  const norm = (v) => {
    if (!v || v === 'N/A') return null;
    const s = String(v).toUpperCase();
    if (s.includes('OUT')) return 'OUT';
    if (s.includes('UNDER')) return 'UNDER';
    return null;
  };

  const leg1 = norm(inputs.crs_stock_vs_nifty);
  const leg2 = norm(inputs.crs_stock_vs_sector);
  const leg3 = norm(inputs.crs_sector_vs_nifty);

  const missingCount = [leg1, leg2, leg3].filter((x) => x == null).length;

  if (missingCount >= 2) {
    dataGaps.push('>= 2 relative strength legs missing; Module 5 scored 0');
    return { score: 0 };
  }

  if (missingCount === 1) {
    dataGaps.push('1 relative strength leg missing; scored closest matched permutation');
    // Fall back to closest row matching known legs
    let bestKey = 'UNDER|UNDER|UNDER';
    let bestScore = 0;
    for (const [key, score] of Object.entries(M5_LOOKUP)) {
      const [k1, k2, k3] = key.split('|');
      let matches = true;
      if (leg1 && leg1 !== k1) matches = false;
      if (leg2 && leg2 !== k2) matches = false;
      if (leg3 && leg3 !== k3) matches = false;
      if (matches) {
        bestKey = key;
        bestScore = score;
        break;
      }
    }
    return { score: bestScore, matchedPermutation: bestKey };
  }

  const key = `${leg1}|${leg2}|${leg3}`;
  const score = M5_LOOKUP[key] ?? 0;
  return { score, matchedPermutation: key };
}

// ─── Module 6: Capital Flow (10 pts) ─────────────────────────────────────────

function scoreModule6(inputs, stockType, dataGaps = []) {
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();

  const isAboveAvg = vol === 'ABOVE_AVERAGE';
  const isPositive = cmf === 'POSITIVE';

  if (stockType === 'Value') {
    if (isAboveAvg && isPositive)  return { score: 10 };
    if (!isAboveAvg && isPositive) return { score: 8 };
    if (isAboveAvg && !isPositive)  return { score: 6 };
    return { score: 2 };
  } else {
    // Growth & Mixed
    if (isAboveAvg && isPositive)  return { score: 10 };
    if (!isAboveAvg && isPositive) return { score: 7 };
    if (isAboveAvg && !isPositive)  return { score: 3 };
    return { score: 1 };
  }
}

// ─── Module 7: Volatility / BBW (5 pts) ──────────────────────────────────────

function scoreModule7(inputs, dataGaps = []) {
  const dir = (inputs.bbw_direction || '').toUpperCase();
  if (dir === 'FALLING') return { score: 5 };
  if (dir === 'RISING')  return { score: 2 };
  dataGaps.push(`BBW direction "${inputs.bbw_direction}" unconfirmed; default 2 pts`);
  return { score: 2 };
}

// ─── Orchestrator: All Modules 1–7 ───────────────────────────────────────────

function scoreAllModules(inputs, stockType, dataGaps = []) {
  const m1 = scoreModule1(inputs, dataGaps);
  const m2 = scoreModule2(inputs, stockType, dataGaps);
  const m3 = scoreModule3(inputs, stockType, dataGaps);
  const m4 = scoreModule4(inputs, dataGaps);
  const m5 = scoreModule5(inputs, dataGaps);
  const m6 = scoreModule6(inputs, stockType, dataGaps);
  const m7 = scoreModule7(inputs, dataGaps);

  const finalScore = Math.max(
    0,
    Math.min(100, m1.score + m2.score + m3.score + m4.score + m5.score + m6.score + m7.score)
  );

  let grade = 'D';
  let label = 'Breakdown';
  let decision = 'Unfavorable Setup';
  let convictionLevel = 'Very Low';

  if (finalScore >= 85) {
    grade = 'A+';
    label = 'Leader';
    decision = 'Favorable – High Conviction';
    convictionLevel = 'Very High';
  } else if (finalScore >= 70) {
    grade = 'A';
    label = 'Strong';
    decision = 'Favorable Setup';
    convictionLevel = 'High';
  } else if (finalScore >= 55) {
    grade = 'B';
    label = 'Developing';
    decision = 'Neutral – Monitor';
    convictionLevel = 'Medium';
  } else if (finalScore >= 40) {
    grade = 'C';
    label = 'Weak';
    decision = 'Caution – Monitor';
    convictionLevel = 'Low';
  }

  return {
    m1, m2, m3, m4, m5, m6, m7,
    finalScore,
    grade,
    label,
    decision,
    convictionLevel,
    convictionScore: finalScore,
  };
}

module.exports = {
  scoreModule1,
  scoreModule2,
  scoreModule3,
  scoreModule4,
  scoreModule5,
  scoreModule6,
  scoreModule7,
  scoreAllModules,
};
