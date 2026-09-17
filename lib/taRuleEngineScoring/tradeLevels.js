'use strict';

/**
 * Trade Levels, Playbook Classification, Ideal-For Voting, and Levels to Watch
 *
 * Implements §9, §10, §11 of technical-analysis-scoring-design-spec.md and
 * lines 375–570 of Technical_skill_text_v4(1).txt.
 */

const { roundPrice, formatPrice } = require('./constants');

// ─── §9 Ideal For Voting ─────────────────────────────────────────────────────

function computeIdealFor(inputs, resolvedPhase) {
  const phase = resolvedPhase || (inputs.wyckoff_phase || '').toUpperCase();
  const sdp = inputs.smaDistancePct || {};
  const rsiZone = inputs.rsi_zone || '';
  const rsiDir = (inputs.rsi_direction || '').toUpperCase();
  const srZone = inputs.sr_zone || '';
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();

  const crsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const crsSector = (inputs.crs_stock_vs_sector || '').toUpperCase();
  const crsSecNifty = (inputs.crs_sector_vs_nifty || '').toUpperCase();

  let swingVotes = 0;
  let positionalVotes = 0;
  let investorVotes = 0;

  // 1. Wyckoff phase
  if (['MARK-UP', 'MARKUP', 'RE-ACCUMULATION', 'DISTRIBUTION'].includes(phase)) {
    swingVotes += 1;
  }
  if (['ACCUMULATION', 'RE-ACCUMULATION', 'DISTRIBUTION', 'RE-DISTRIBUTION'].includes(phase)) {
    positionalVotes += 1;
  }
  if (['ACCUMULATION', 'RE-DISTRIBUTION', 'MARKDOWN'].includes(phase)) {
    investorVotes += 1;
  }

  // 2. SMA distance - STRICT hierarchy, first match wins, ONLY ONE vote total
  const d200 = sdp.sma200 != null ? Math.abs(parseFloat(sdp.sma200)) : 999;
  const d100 = sdp.sma100 != null ? Math.abs(parseFloat(sdp.sma100)) : 999;
  const d50  = sdp.sma50  != null ? Math.abs(parseFloat(sdp.sma50))  : 999;
  const d20  = sdp.sma20  != null ? Math.abs(parseFloat(sdp.sma20))  : 999;

  if (d200 <= 5) {
    investorVotes += 1;
  } else if (d100 <= 4) {
    positionalVotes += 1;
  } else if (d50 <= 3) {
    swingVotes += 1;
  } else if (d20 <= 2) {
    swingVotes += 1;
  }

  // 3. RSI
  const isRising = rsiDir === 'RISING';
  const isFalling = rsiDir === 'FALLING';
  if (isRising && ['0-30', '30-50', '50-70'].includes(rsiZone)) {
    swingVotes += 1;
    positionalVotes += 1;
  }
  if (
    (rsiZone === '0-30' && isFalling) ||
    (rsiZone === '0-30' && isRising) ||
    (rsiZone === '50-70' && isRising) ||
    (rsiZone === '70-100' && isRising)
  ) {
    investorVotes += 1;
  }

  // 4. S/R zone
  if (['Confirmed Breakout', 'At Support'].includes(srZone)) {
    swingVotes += 1;
    positionalVotes += 1;
  }
  if (['Confirmed Breakout', 'At Support', 'Approaching Support'].includes(srZone)) {
    investorVotes += 1;
  }

  // 5. Flow (independent votes)
  if (vol === 'ABOVE_AVERAGE') swingVotes += 1;
  if (cmf === 'POSITIVE')      positionalVotes += 1;
  if (cmf === 'POSITIVE')      investorVotes += 1;

  // 6. Relative strength
  const secOut = crsSector.includes('OUT');
  const secNiftyOut = crsSecNifty.includes('OUT');
  const stkNiftyOut = crsNifty.includes('OUT');

  if (secOut && secNiftyOut) {
    swingVotes += 1;
    positionalVotes += 1;
    investorVotes += 1;
  } else if (secOut && !secNiftyOut) {
    positionalVotes += 1;
    investorVotes += 1;
  } else if (!secOut && secNiftyOut) {
    investorVotes += 1;
  } else if (stkNiftyOut) {
    investorVotes += 1;
  }

  const idealForScores = {
    swing: Math.min(6, swingVotes),
    positional: Math.min(6, positionalVotes),
    investor: Math.min(6, investorVotes),
  };

  let idealFor = 'Not Suitable';
  let timeframe = '-';

  if (idealForScores.swing <= 3 && idealForScores.positional <= 3 && idealForScores.investor <= 3) {
    idealFor = 'Not Suitable';
    timeframe = '-';
  } else {
    // Tie-break: Investor > Positional > Swing
    let winner = 'investor';
    let maxV = idealForScores.investor;

    if (idealForScores.positional > maxV) {
      winner = 'positional';
      maxV = idealForScores.positional;
    }
    if (idealForScores.swing > maxV) {
      winner = 'swing';
      maxV = idealForScores.swing;
    }

    if (winner === 'swing') {
      idealFor = 'Swing Entry';
      timeframe = '0-3 Months';
    } else if (winner === 'positional') {
      idealFor = 'Positional Add';
      timeframe = '3-6 Months';
    } else {
      idealFor = 'Investor Entry';
      timeframe = '6 Months+';
    }
  }

  return { idealFor, timeframe, idealForScores };
}

// ─── §10 Playbook Classification ─────────────────────────────────────────────

function classifyPlaybook(inputs, finalScore, resolvedPhase) {
  if (finalScore < 55) {
    return { playbook: 'No Setup', breakoutQuality: null, triggerSMA: null };
  }

  const phase = resolvedPhase || (inputs.wyckoff_phase || '').toUpperCase();
  const srZone = inputs.sr_zone || '';
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();
  const adxZone = inputs.adx_zone || '';
  let adxDir = (inputs.adx_direction || '').toUpperCase();
  if (adxDir === 'FLAT') adxDir = 'FALLING';
  const rsiZone = inputs.rsi_zone || '';
  const rsiDir = (inputs.rsi_direction || '').toUpperCase();
  const bbwDir = (inputs.bbw_direction || '').toUpperCase();
  const above200 = inputs.price_vs_sma200 === 'ABOVE';

  const sdp = inputs.smaDistancePct || {};
  const d50 = sdp.sma50 != null ? Math.abs(parseFloat(sdp.sma50)) : 999;
  const d100 = sdp.sma100 != null ? Math.abs(parseFloat(sdp.sma100)) : 999;

  const crsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const crsSector = (inputs.crs_stock_vs_sector || '').toUpperCase();
  const crsSecNifty = (inputs.crs_sector_vs_nifty || '').toUpperCase();
  const crsOutCount = [crsNifty, crsSector, crsSecNifty].filter((x) => x.includes('OUT')).length;
  const crsUnderCount = [crsNifty, crsSector, crsSecNifty].filter((x) => x.includes('UNDER')).length;

  // 1. EXHAUSTION
  if (
    ['50-70', '70-100'].includes(adxZone) &&
    adxDir === 'RISING' &&
    bbwDir === 'RISING' &&
    rsiZone === '70-100' &&
    rsiDir === 'RISING'
  ) {
    return { playbook: 'Exhaustion', breakoutQuality: null, triggerSMA: null };
  }

  // 2. DISTRIBUTION
  if (
    phase === 'DISTRIBUTION' &&
    cmf === 'NEGATIVE' &&
    vol === 'ABOVE_AVERAGE' &&
    crsUnderCount === 3
  ) {
    return { playbook: 'Distribution', breakoutQuality: null, triggerSMA: null };
  }

  // 3. BREAKOUT
  if (
    srZone === 'Confirmed Breakout' &&
    ['MARK-UP', 'MARKUP', 'RE-ACCUMULATION'].includes(phase) &&
    adxDir === 'RISING' &&
    crsOutCount >= 2
  ) {
    return { playbook: 'Breakout', breakoutQuality: 'High Conviction', triggerSMA: null };
  }

  // 4. PULLBACK
  if (
    above200 &&
    (d50 <= 3 || d100 <= 3) &&
    rsiZone === '30-50' &&
    rsiDir === 'RISING' &&
    cmf === 'POSITIVE' &&
    crsOutCount >= 2
  ) {
    const triggerSMA = d50 <= 3 ? 'sma50' : 'sma100';
    return { playbook: 'Pullback', breakoutQuality: null, triggerSMA };
  }

  // 5. BASE BUILDING
  if (
    ['ACCUMULATION', 'RE-ACCUMULATION'].includes(phase) &&
    ['0-15', '15-25'].includes(adxZone) &&
    bbwDir === 'FALLING' &&
    above200
  ) {
    return { playbook: 'Base Building', breakoutQuality: null, triggerSMA: null };
  }

  return { playbook: 'No Setup', breakoutQuality: null, triggerSMA: null };
}

// ─── §11 Price Anchors & Trade Levels ────────────────────────────────────────

function computeTradeLevels(inputs, playbookResult) {
  const { playbook, triggerSMA } = playbookResult;

  const support = inputs.sr_support_price != null ? parseFloat(inputs.sr_support_price) : null;
  const resistance = inputs.sr_resistance_price != null ? parseFloat(inputs.sr_resistance_price) : null;
  const sma20 = inputs.sma20 != null ? parseFloat(inputs.sma20) : null;
  const sma50 = inputs.sma50 != null ? parseFloat(inputs.sma50) : null;
  const sma100 = inputs.sma100 != null ? parseFloat(inputs.sma100) : null;
  const sma200 = inputs.sma200 != null ? parseFloat(inputs.sma200) : null;

  const anchors = {
    support: roundPrice(support),
    resistance: roundPrice(resistance),
    sma20: roundPrice(sma20),
    sma50: roundPrice(sma50),
    sma100: roundPrice(sma100),
    sma200: roundPrice(sma200),
  };

  // Candidate evaluation helper
  function evaluateStop(idealEntry, minPct, maxPct, clampPct) {
    if (idealEntry == null || isNaN(idealEntry) || idealEntry <= 0) return null;

    const candidateList = [
      { name: 'support', val: support },
      { name: 'sma20',   val: sma20 },
      { name: 'sma50',   val: sma50 },
      { name: 'sma100',  val: sma100 },
      { name: 'sma200',  val: sma200 },
    ];

    const qualifying = [];
    for (const c of candidateList) {
      if (c.val == null || isNaN(c.val)) continue;
      if (c.val >= idealEntry) continue; // must be strictly below idealEntry

      const candidateStop = c.val * 0.98; // 2% buffer
      const distPct = (idealEntry - candidateStop) / idealEntry * 100;

      if (distPct >= minPct && distPct <= maxPct) {
        qualifying.push({ name: c.name, stop: candidateStop, distPct });
      }
    }

    if (qualifying.length === 1) {
      return roundPrice(qualifying[0].stop);
    }

    if (qualifying.length > 1) {
      // Sort by smallest distance (nearest to idealEntry)
      qualifying.sort((a, b) => a.distPct - b.distPct);
      // If two qualifying candidates are within 1% distance of each other, prefer support
      if (Math.abs(qualifying[0].distPct - qualifying[1].distPct) <= 1) {
        const supMatch = qualifying.find((q) => q.name === 'support');
        if (supMatch) return roundPrice(supMatch.stop);
      }
      return roundPrice(qualifying[0].stop);
    }

    // Clamp if none qualify
    return roundPrice(idealEntry * (1 - clampPct / 100));
  }

  // 1. SWING
  let swingEntry = null;
  if (playbook === 'BREAKOUT') swingEntry = resistance;
  else if (playbook === 'PULLBACK' && triggerSMA === 'sma50') swingEntry = sma50;
  else if (playbook === 'PULLBACK') swingEntry = support;
  else if (playbook === 'BASE BUILDING') swingEntry = support;
  else if (playbook === 'EXHAUSTION') swingEntry = sma20;
  else swingEntry = resistance ?? support;

  const swingStop = evaluateStop(swingEntry, 3, 8, 8);
  let swingTarget = null;
  if (swingEntry != null && swingStop != null) {
    const R = swingEntry - swingStop;
    const formulaTarget = swingEntry + 2 * R;
    swingTarget = resistance != null ? Math.max(formulaTarget, resistance) : formulaTarget;
    swingTarget = roundPrice(swingTarget);
  }

  // 2. POSITIONAL
  let posEntry = null;
  if (playbook === 'BREAKOUT') posEntry = resistance;
  else if (playbook === 'PULLBACK' && triggerSMA === 'sma100') posEntry = sma100;
  else if (playbook === 'PULLBACK') posEntry = support;
  else if (playbook === 'BASE BUILDING') posEntry = support;
  else if (playbook === 'EXHAUSTION') posEntry = sma50;
  else posEntry = resistance ?? support;

  const posStop = evaluateStop(posEntry, 8, 15, 15);
  let posTarget = null;
  if (posEntry != null && posStop != null) {
    const R = posEntry - posStop;
    const formulaTarget = posEntry + 3 * R;
    posTarget = resistance != null ? Math.max(formulaTarget, resistance) : formulaTarget;
    posTarget = roundPrice(posTarget);
  }

  // 3. INVESTOR
  let invEntry = null;
  if (playbook === 'BREAKOUT') invEntry = resistance;
  else if (playbook === 'PULLBACK') invEntry = support;
  else if (playbook === 'BASE BUILDING') invEntry = support;
  else if (playbook === 'EXHAUSTION') invEntry = sma100;
  else invEntry = resistance ?? support;

  const invStop = evaluateStop(invEntry, 15, 25, 25);
  let invTarget = null;
  if (invEntry != null && invStop != null) {
    const R = invEntry - invStop;
    const formulaTarget = invEntry + 3 * R;
    invTarget = resistance != null ? Math.max(formulaTarget, resistance) : formulaTarget;
    invTarget = roundPrice(invTarget);
  }

  return {
    priceAnchors: anchors,
    swing: {
      idealEntry: swingEntry != null ? roundPrice(swingEntry) : null,
      stopLoss: swingStop,
      target: swingTarget,
    },
    positional: {
      idealEntry: posEntry != null ? roundPrice(posEntry) : null,
      stopLoss: posStop,
      target: posTarget,
    },
    investor: {
      idealEntry: invEntry != null ? roundPrice(invEntry) : null,
      stopLoss: invStop,
      target: invTarget,
    },
  };
}

function computeLevelsToWatch(inputs, idealFor) {
  const immediatePrice = roundPrice(inputs.sr_support_price);
  const structuralPrice = roundPrice(inputs.sr_support_price != null ? inputs.sr_support_price : inputs.s1);
  const regimePrice = roundPrice(inputs.sma200);

  const fmt = (p) => (p != null && !isNaN(p) ? formatPrice(p) : '-');
  let horizonNote = 'Break below Rs.5400 = structural change.';
  if (idealFor === 'Swing Entry') {
    horizonNote = `Break below Rs.${fmt(immediatePrice)} = exit setup.`;
  } else if (idealFor === 'Positional Add') {
    horizonNote = `Close below Rs.${fmt(structuralPrice)} = reassess position.`;
  } else {
    horizonNote = `Break below Rs.${fmt(regimePrice)} = structural change.`;
  }

  const levelsArray = [
    { type: 'immediate',  price: immediatePrice,  label: 'Short term support' },
    { type: 'structural', price: structuralPrice, label: 'Key support' },
    { type: 'regime',     price: regimePrice,     label: 'Long term average' },
  ];

  return { levelsArray, horizonNote };
}

module.exports = {
  computeIdealFor,
  classifyPlaybook,
  computeTradeLevels,
  computeLevelsToWatch,
};
