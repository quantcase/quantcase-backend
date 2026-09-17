'use strict';

/**
 * Deterministic Technical Analysis Scoring Engine
 *
 * Implements Ajay's rule-based technical analysis framework programmatically,
 * replacing the Vertex AI LLM call with a deterministic, cost-free rule engine.
 */

const { INDICATOR_IDS, INDICATOR_META } = require('./constants');
const { classifyStockType } = require('./stockType');
const { scoreAllModules } = require('./scoringModules');
const {
  getIndicatorSentiment,
  getIndicatorTag,
  computeDirectionFlag,
  resolveCompositeTag,
} = require('./tagsAndSignals');
const {
  computeIdealFor,
  classifyPlaybook,
  computeTradeLevels,
  computeLevelsToWatch,
} = require('./tradeLevels');
const {
  INDICATOR_TEXT_BANK,
  buildTabSummaries,
  computePriorityWatchout,
  buildActionableInsights,
  buildWhatCanChange,
  buildCurrentRegime,
  buildBottomLine,
} = require('./templateBank');

/**
 * Extract normalized inputs from taResult (the output of technicalAnalysis.analyze(symbol)).
 */
function extractInputsFromTaResult(taResult, symbol) {
  const d = taResult || {};
  const re = d.ruleEngine || {};
  const se = re.structureEngine || {};
  const te = re.trendEngine || {};
  const ti = re.timingEngine || {};
  const de = re.dominanceEngine?.leadership || {};
  const td = te.trendDirection || {};
  const tq = te.trendQuality || {};
  const mom = ti.momentum || {};
  const vol = ti.volatility || {};
  const ms = se.marketStructure || {};
  const part = se.participation || {};
  const st = d.stockType || {};
  const stStats = st.stats || {};

  const staticSR = d.supportResistance?.static || {};
  const supports = staticSR.support || [];
  const resistances = staticSR.resistance || [];
  const nearestSupport = supports.length > 0 ? supports[0] : null;
  const nearestResistance = resistances.length > 0 ? resistances[0] : null;

  const cmp = d.price?.cmp != null ? Number(d.price.cmp) : null;

  // S/R proximity
  let supportProximityPct = null;
  if (nearestSupport != null && cmp != null && cmp > 0) {
    supportProximityPct = Math.round(Math.abs((cmp - nearestSupport) / cmp * 100) * 100) / 100;
  }
  let resistanceProximityPct = null;
  if (nearestResistance != null && cmp != null && cmp > 0) {
    resistanceProximityPct = Math.round(Math.abs((nearestResistance - cmp) / cmp * 100) * 100) / 100;
  }

  // Classify S/R zone
  let srZone = 'Mid Range';
  const volSignal = part.volumeSignal || 'N/A';
  if (cmp != null) {
    const sPct = (nearestSupport != null && nearestSupport > 0) ? (cmp - nearestSupport) / nearestSupport : null;
    const rPct = (nearestResistance != null && nearestResistance > 0) ? (cmp - nearestResistance) / nearestResistance : null;

    if (rPct != null && rPct > 0.02) {
      srZone = volSignal === 'ABOVE_AVERAGE' ? 'Confirmed Breakout' : 'Mid Range';
    } else if (sPct != null && sPct < -0.02) {
      srZone = 'Breakdown';
    } else if (sPct != null && Math.abs(sPct) <= 0.02) {
      srZone = 'At Support';
    } else if (rPct != null && Math.abs(rPct) <= 0.02) {
      srZone = 'At Resistance';
    } else if (sPct != null && sPct > 0.02 && sPct <= 0.10) {
      srZone = 'Approaching Support';
    } else if (rPct != null && rPct > -0.10) {
      srZone = 'Approaching Resistance';
    }
  }

  // Support strength note
  let supportStrength = 'MEDIUM';
  if (supportProximityPct != null) {
    if (supportProximityPct < 3) supportStrength = 'HIGH (proximity < 3%)';
    else if (supportProximityPct > 10) supportStrength = 'LOW (proximity > 10%)';
  }

  // ADX Zone
  const adxNum = d.trend?.adx14 != null ? Number(d.trend.adx14) : (tq.adx != null ? Number(tq.adx) : null);
  let adxZone = '15-25';
  if (adxNum != null && !isNaN(adxNum)) {
    if (adxNum < 15) adxZone = '0-15';
    else if (adxNum < 25) adxZone = '15-25';
    else if (adxNum < 50) adxZone = '25-50';
    else if (adxNum < 70) adxZone = '50-70';
    else adxZone = '70-100';
  }

  // RSI Zone
  const rsiNum = d.momentum?.rsi?.value != null ? Number(d.momentum.rsi.value) : (mom.rsi != null ? Number(mom.rsi) : null);
  let rsiZone = '30-50';
  if (rsiNum != null && !isNaN(rsiNum)) {
    if (rsiNum < 30) rsiZone = '0-30';
    else if (rsiNum < 50) rsiZone = '30-50';
    else if (rsiNum < 70) rsiZone = '50-70';
    else rsiZone = '70-100';
  }

  // SMA 50 slope
  const sma50Now = parseFloat(d.movingAverages?.sma?.[50]);
  const sma50Prev = parseFloat(d.movingAverages?.sma50Prev10);
  const sma50Slope = (!isNaN(sma50Now) && !isNaN(sma50Prev))
    ? (sma50Now > sma50Prev ? 'Rising' : 'Falling')
    : 'N/A';

  return {
    symbol: symbol || d.symbol,
    price: cmp,
    // Step 0 stats
    adx_avg_100: stStats.adx100Avg ?? null,
    rsi_pct_above_55: stStats.rsiAbove55Pct ?? null,
    rsi_pct_below_50: stStats.rsiBelow50Pct ?? null,
    sma200_touch_count: stStats.touchCountSMA200 ?? null,
    sma200_touch_window_bars: stStats.windowBars ?? 200,
    sma50_upbar_pct: stStats.upBarSMA50Pct ?? null,
    sma50_downbar_pct: stStats.downBarSMA50Pct ?? null,
    price_vs_sma200_pct: d.smaDistancePct?.sma200 ?? stStats.distSMA200Pct ?? null,
    price_vs_sma100_pct: d.smaDistancePct?.sma100 ?? null,
    price_vs_sma50_pct:  d.smaDistancePct?.sma50 ?? null,
    price_vs_sma20_pct:  d.smaDistancePct?.sma20 ?? null,
    smaDistancePct: d.smaDistancePct || {},

    // SMA block
    price_vs_sma20:  td.priceVsSMA20 ?? 'N/A',
    price_vs_sma50:  td.priceVsSMA50 ?? 'N/A',
    price_vs_sma100: td.priceVsSMA100 ?? 'N/A',
    price_vs_sma200: td.priceVsSMA200 ?? 'N/A',
    sma20:  d.movingAverages?.sma?.[20] ?? null,
    sma50:  d.movingAverages?.sma?.[50] ?? null,
    sma100: d.movingAverages?.sma?.[100] ?? null,
    sma200: d.movingAverages?.sma?.[200] ?? null,
    sma50_slope: sma50Slope,
    valid_confirmed_cross_above_sma200: st.validSMA200Cross ?? null,

    // ADX / RSI / BBW
    adx_value: adxNum,
    adx_zone: adxZone,
    adx_direction: tq.adxTrend ?? 'FLAT',
    rsi_value: rsiNum,
    rsi_zone: rsiZone,
    rsi_direction: d.momentum?.rsi?.trend ?? 'RISING',
    bbw_value: vol.bbWidth ?? null,
    bbw_direction: vol.expanding === true ? 'Rising' : vol.expanding === false ? 'Falling' : 'Rising',

    // Volume & CMF & Wyckoff
    volume_signal: part.volumeSignal ?? 'ABOVE_AVERAGE',
    cmf_signal: part.cmfSignal ?? 'POSITIVE',
    cmf_value: part.cmf ?? null,
    wyckoff_phase: ms.wyckoffPhase ?? d.meta?.phase ?? 'MARK-UP',

    // S/R
    sr_zone: srZone,
    sr_support_price: nearestSupport,
    sr_support_proximity_pct: supportProximityPct,
    sr_support_strength: supportStrength,
    sr_resistance_price: nearestResistance,
    sr_resistance_proximity_pct: resistanceProximityPct,

    // Reference levels
    s1: d.pivotPoints?.s1 ?? null,
    r1: d.pivotPoints?.r1 ?? null,

    // CRS
    crs_stock_vs_nifty: de.vsNifty?.signal ?? de.vsNifty?.status ?? 'UNDERPERFORMING',
    crs_stock_vs_sector: de.vsSector?.signal ?? de.vsSector?.status ?? 'UNDERPERFORMING',
    crs_sector_vs_nifty: de.vsSectorNifty?.signal ?? de.sectorVsNifty?.signal ?? de.sectorVsNifty?.status ?? 'UNDERPERFORMING',
  };
}

/**
 * Execute the full deterministic technical analysis pipeline.
 *
 * @param {object} taResult - Output of technicalAnalysis.analyze(symbol)
 * @param {number|null} previousScore - Prior final_score
 * @param {object} options - { asOfDate: 'YYYY-MM-DD' }
 * @returns {object} { compact, expanded, scores, stockClassification, decisionIntelligence }
 */
function computeRuleBasedTechnicals(taResult, previousScore = null, options = {}) {
  const dataGaps = [];
  const symbol = taResult?.symbol || options.symbol || 'TICKER';
  const inputs = extractInputsFromTaResult(taResult, symbol);

  // 1. Step 0: Stock Type Classification
  const stockClassification = classifyStockType(inputs, dataGaps);
  const stockType = stockClassification.stock_type;

  // 2. Modules 1–7 Scoring
  const scoring = scoreAllModules(inputs, stockType, dataGaps);
  const resolvedPhase = scoring.m1.resolvedPhase;

  // 3. Ideal For Horizon Vote
  const idealForResult = computeIdealFor(inputs, resolvedPhase);

  // 4. Playbook Classification
  const playbookResult = classifyPlaybook(inputs, scoring.finalScore, resolvedPhase);

  // 5. Price Anchors & Trade Levels
  const tradeLevels = computeTradeLevels(inputs, playbookResult);

  // 6. Levels to Watch
  const { levelsArray, horizonNote } = computeLevelsToWatch(inputs, idealForResult.idealFor);

  // 7. Composite Tag
  const compositeTagResult = resolveCompositeTag(
    inputs,
    scoring.finalScore,
    stockType,
    previousScore,
    resolvedPhase,
    options.asOfDate
  );

  // 8. Indicators (8 objects)
  const indicators = INDICATOR_IDS.map((id) => {
    const tag = getIndicatorTag(id, inputs, stockType, resolvedPhase);
    const sentiment = getIndicatorSentiment(id, inputs, stockType, resolvedPhase);
    const textEntry = INDICATOR_TEXT_BANK[id]?.[tag] || {
      explanation: `${INDICATOR_META[id]?.name} conditions reflect prevailing market trends.`,
      growthWatchout: 'Monitor for structural changes above key support.',
      valueWatchout: 'Look for buying confirmation near support.',
    };

    return {
      id,
      name: INDICATOR_META[id].name,
      tab: INDICATOR_META[id].tab,
      tag,
      sentiment,
      explanation: textEntry.explanation,
      growthWatchout: textEntry.growthWatchout,
      valueWatchout: textEntry.valueWatchout,
    };
  });

  // 9. Tab Summaries & Text
  const tabSummaries = buildTabSummaries(indicators, tradeLevels.priceAnchors);
  const priorityWatchout = computePriorityWatchout(inputs, 'm6', tradeLevels.priceAnchors);
  const actionableInsights = buildActionableInsights(tradeLevels, scoring.finalScore, tradeLevels.priceAnchors);
  const whatCanChange = buildWhatCanChange(tradeLevels.priceAnchors);
  const currentRegime = buildCurrentRegime(playbookResult.playbook, scoring.finalScore);
  const bottomLine = buildBottomLine(stockType, scoring.finalScore, tradeLevels.priceAnchors);

  // Output scores object
  const scores = {
    structure_wyckoff_sr: scoring.m1.score,
    trend_sma: scoring.m2.score,
    momentum_rsi: scoring.m3.score,
    trend_maturity_adx: scoring.m4.score,
    leadership_rs: scoring.m5.score,
    capital_flow: scoring.m6.score,
    volatility_bbw: scoring.m7.score,
    final_score: scoring.finalScore,
    grade: scoring.grade,
    label: scoring.label,
    dataGaps,
  };

  // Compact LLM-compatible format (matches LLM output schema)
  const compactDecisionIntelligence = {
    tag: compositeTagResult.tag,
    bottomLine,
    lens: stockType,
    idealFor: idealForResult.idealFor,
    playbook: playbookResult.playbook,
    breakoutQuality: playbookResult.breakoutQuality,
    directionFlag: compositeTagResult.directionFlag,
    previousScore,
    timeframe: idealForResult.timeframe,
    convictionLevel: scoring.convictionLevel,
    convictionScore: scoring.finalScore,
    currentRegimeLabel: currentRegime.label,
    currentRegimeDescription: currentRegime.description,
    swingScore: idealForResult.idealForScores.swing,
    positionalScore: idealForResult.idealForScores.positional,
    investorScore: idealForResult.idealForScores.investor,
    structureSummary: tabSummaries.structure,
    trendSummary: tabSummaries.trend,
    timingSummary: tabSummaries.timing,
    relativeStrengthSummary: tabSummaries.relativeStrength,
    priorityWatchout,
    actionableInsights,
    priceAnchors: tradeLevels.priceAnchors,
    whatCanChange,
    indicators: indicators.map((ind) => ({
      id: ind.id,
      tag: ind.tag,
      sentiment: ind.sentiment,
      explanation: ind.explanation,
      growthWatchout: ind.growthWatchout,
      valueWatchout: ind.valueWatchout,
    })),
    levelsToWatch: levelsArray,
    horizonNote,
  };

  // Expanded format (matches the persisted DB record and UI consumption)
  const expandedDecisionIntelligence = {
    tag: compositeTagResult.tag,
    bottomLine,
    lens: stockType,
    idealFor: idealForResult.idealFor,
    playbook: playbookResult.playbook,
    breakoutQuality: playbookResult.breakoutQuality,
    directionFlag: compositeTagResult.directionFlag,
    previousScore,
    timeframe: idealForResult.timeframe,
    convictionLevel: scoring.convictionLevel,
    convictionScore: scoring.finalScore,
    currentRegime,
    idealForScores: idealForResult.idealForScores,
    ruleEngine: {
      tabSummaries,
    },
    priorityWatchout,
    priceAnchors: tradeLevels.priceAnchors,
    levelsToWatch: {
      immediate: {
        price: levelsArray.find((l) => l.type === 'immediate')?.price ?? null,
        label: levelsArray.find((l) => l.type === 'immediate')?.label ?? 'Short term support',
      },
      structural: {
        price: levelsArray.find((l) => l.type === 'structural')?.price ?? null,
        label: levelsArray.find((l) => l.type === 'structural')?.label ?? 'Key support',
      },
      regime: {
        price: levelsArray.find((l) => l.type === 'regime')?.price ?? null,
        label: levelsArray.find((l) => l.type === 'regime')?.label ?? 'Long term average',
      },
      horizonNote,
    },
    whatCanChange,
    indicators,
    actionableInsight: actionableInsights[0] || null,
    actionableInsight_positional: actionableInsights[1] || null,
    actionableInsight_investor: actionableInsights[2] || null,
    actionableInsights,
  };

  const expandedInsight = {
    scores,
    stockClassification,
    decisionIntelligence: expandedDecisionIntelligence,
    ruleEngine: taResult?.ruleEngine ?? null,
  };

  return {
    compact: {
      decisionIntelligence: compactDecisionIntelligence,
      scores,
      stockClassification,
    },
    expanded: expandedInsight,
  };
}

module.exports = {
  computeRuleBasedTechnicals,
  extractInputsFromTaResult,
};
