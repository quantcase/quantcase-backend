'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function na(val) {
  return val != null ? val : 'N/A';
}

function buildContext(taResult) {
  const re = taResult.ruleEngine;
  const se = re?.structureEngine;
  const te = re?.trendEngine;
  const ti = re?.timingEngine;
  const de = re?.dominanceEngine?.leadership;

  return {
    symbol:        taResult.symbol,
    sector:        na(taResult.meta?.macroSector),
    overallSignal: na(taResult.signals?.overall),
    score:         na(taResult.signals?.score),

    wyckoffPhase:               na(se?.marketStructure?.wyckoffPhase),
    marketStructureGrowthOutput: na(se?.marketStructure?.growthOutput),
    marketStructureValueOutput:  na(se?.marketStructure?.valueOutput),
    participation:               na(se?.participation?.growthOutput),
    participationValue:          na(se?.participation?.valueOutput),
    priceStructure:              na(se?.priceStructure?.growthOutput),
    priceStructureValue:         na(se?.priceStructure?.valueOutput),

    trendDirectionGrowth:  na(te?.trendDirection?.growthOutput),
    trendDirectionValue:   na(te?.trendDirection?.valueOutput),
    priceVsSMA20:          na(te?.trendDirection?.priceVsSMA20),
    priceVsSMA50:          na(te?.trendDirection?.priceVsSMA50),
    priceVsSMA100:         na(te?.trendDirection?.priceVsSMA100),
    priceVsSMA200:         na(te?.trendDirection?.priceVsSMA200),
    adxCondition:          na(te?.trendQuality?.condition),
    adx:                   na(te?.trendQuality?.adx),
    adxTrend:              na(te?.trendQuality?.adxTrend),
    trendQualityGrowth:    na(te?.trendQuality?.growthOutput),
    trendQualityValue:     na(te?.trendQuality?.valueOutput),

    rsiZone:          na(ti?.momentum?.rsiZone),
    rsi:              na(ti?.momentum?.rsi),
    momentumGrowth:   na(ti?.momentum?.growthOutput),
    momentumValue:    na(ti?.momentum?.valueOutput),
    bbCondition:      na(ti?.volatility?.condition),
    bbWidth:          na(ti?.volatility?.bbWidth),
    bbExpanding:      na(ti?.volatility?.expanding),
    volatilityGrowth: na(ti?.volatility?.growthOutput),
    volatilityValue:  na(ti?.volatility?.valueOutput),

    vsNiftySignal:  na(de?.vsNifty?.signal),
    vsNiftyGrowth:  na(de?.vsNifty?.growthOutput),
    vsNiftyValue:   na(de?.vsNifty?.valueOutput),
    vsSectorSignal: na(de?.vsSector?.signal),
    vsSectorGrowth: na(de?.vsSector?.growthOutput),
    vsSectorValue:  na(de?.vsSector?.valueOutput),

    decisionSummary:  na(re?.decisionContext?.summary),
    marketBias:       na(re?.decisionContext?.marketBias),
    overallCondition: na(re?.decisionContext?.overallCondition),
    alerts: Array.isArray(re?.decisionContext?.alerts)
      ? re.decisionContext.alerts.join(', ')
      : 'N/A',

    wyckoffGrowthWatchout:        na(se?.marketStructure?.growthWatchout),
    wyckoffValueWatchout:         na(se?.marketStructure?.valueWatchout),
    participationGrowthWatchout:  na(se?.participation?.growthWatchout),
    participationValueWatchout:   na(se?.participation?.valueWatchout),
    priceStructureGrowthWatchout: na(se?.priceStructure?.growthWatchout),
    priceStructureValueWatchout:  na(se?.priceStructure?.valueWatchout),
    adxGrowthWatchout:            na(te?.trendQuality?.growthWatchout),
    adxValueWatchout:             na(te?.trendQuality?.valueWatchout),
    rsiGrowthWatchout:            na(ti?.momentum?.growthWatchout),
    rsiValueWatchout:             na(ti?.momentum?.valueWatchout),
    bbGrowthWatchout:             na(ti?.volatility?.growthWatchout),
    bbValueWatchout:              na(ti?.volatility?.valueWatchout),
    vsNiftyGrowthWatchout:        na(de?.vsNifty?.growthWatchout),
    vsNiftyValueWatchout:         na(de?.vsNifty?.valueWatchout),
    vsSectorGrowthWatchout:       na(de?.vsSector?.growthWatchout),
    vsSectorValueWatchout:        na(de?.vsSector?.valueWatchout),
  };
}

/**
 * Format the dynamic data block from a technical analysis result object.
 * Injected into {{DATA_BLOCK}} in PROMPT_TEMPLATE.
 */
function buildDataBlock(taResult) {
  const ctx = buildContext(taResult);
  return `SYMBOL: ${ctx.symbol} | SECTOR: ${ctx.sector}
OVERALL SIGNAL: ${ctx.overallSignal} (score: ${ctx.score}/100)
MARKET BIAS: ${ctx.marketBias} | CONDITION: ${ctx.overallCondition}

=== STRUCTURE ENGINE ===
Wyckoff Phase: ${ctx.wyckoffPhase}
Market Structure (Growth): ${ctx.marketStructureGrowthOutput}
Market Structure (Value): ${ctx.marketStructureValueOutput}
Participation (Growth): ${ctx.participation}
Participation (Value): ${ctx.participationValue}
Price Structure (Growth): ${ctx.priceStructure}
Price Structure (Value): ${ctx.priceStructureValue}

=== TREND ENGINE ===
SMA Position: 20=${ctx.priceVsSMA20}, 50=${ctx.priceVsSMA50}, 100=${ctx.priceVsSMA100}, 200=${ctx.priceVsSMA200}
Trend Direction (Growth): ${ctx.trendDirectionGrowth}
Trend Direction (Value): ${ctx.trendDirectionValue}
ADX: ${ctx.adx} (${ctx.adxCondition}, trend: ${ctx.adxTrend})
Trend Quality (Growth): ${ctx.trendQualityGrowth}
Trend Quality (Value): ${ctx.trendQualityValue}

=== TIMING ENGINE ===
RSI: ${ctx.rsi} (zone: ${ctx.rsiZone})
Momentum (Growth): ${ctx.momentumGrowth}
Momentum (Value): ${ctx.momentumValue}
BB Width: ${ctx.bbWidth} (${ctx.bbCondition}, expanding: ${ctx.bbExpanding})
Volatility (Growth): ${ctx.volatilityGrowth}
Volatility (Value): ${ctx.volatilityValue}

=== DOMINANCE ENGINE ===
vs Nifty (${ctx.vsNiftySignal}): Growth: ${ctx.vsNiftyGrowth} | Value: ${ctx.vsNiftyValue}
vs Sector (${ctx.vsSectorSignal}): Growth: ${ctx.vsSectorGrowth} | Value: ${ctx.vsSectorValue}

=== DECISION CONTEXT ===
Summary: ${ctx.decisionSummary}
Risk Alerts: ${ctx.alerts}

=== INDICATOR WATCHOUTS ===
Market Structure | Growth: ${ctx.wyckoffGrowthWatchout} | Value: ${ctx.wyckoffValueWatchout}
Participation | Growth: ${ctx.participationGrowthWatchout} | Value: ${ctx.participationValueWatchout}
Price Structure | Growth: ${ctx.priceStructureGrowthWatchout} | Value: ${ctx.priceStructureValueWatchout}
Trend Direction | Growth: ${ctx.trendDirectionGrowth} | Value: ${ctx.trendDirectionValue}
Trend Quality (ADX) | Growth: ${ctx.adxGrowthWatchout} | Value: ${ctx.adxValueWatchout}
Momentum (RSI) | Growth: ${ctx.rsiGrowthWatchout} | Value: ${ctx.rsiValueWatchout}
Volatility (BB) | Growth: ${ctx.bbGrowthWatchout} | Value: ${ctx.bbValueWatchout}
Relative Strength | vs Nifty: ${ctx.vsNiftyGrowthWatchout} | vs Sector: ${ctx.vsSectorGrowthWatchout}`;
}

// ─── Static prompt template ───────────────────────────────────────────────────

const PROMPT_TEMPLATE = `You are a systematic equity analyst. Based on the structured technical analysis below, generate a Decision Intelligence summary in strict JSON.

{{DATA_BLOCK}}

---
Respond ONLY with a valid JSON object matching this exact schema (no markdown fences, no preamble):
{
  "tag": "<2-5 words alignment tag, e.g. Full Bearish Alignment | Bullish Momentum Building | Mixed Signals Neutral>",
  "lens": "<Value | Growth>",
  "idealFor": "<Investment | Swing | Positional>",
  "timeframe": "<6M+ | 3-6M | 0-3M>",
  "currentRegime": {
    "label": "<2-4 words, e.g. Strong Uptrend | Sideways Consolidation | Distribution Phase | Oversold Reversal>",
    "description": "<max 12 words, one sharp phrase characterizing the structure>"
  },
  "actionBias": "<max 25 words, one crisp actionable sentence combining growth and value lenses>",
  "actionableInsight": {
    "action": "<Strong Accumulate | Accumulate | Add | Neutral | Trim | Cut | Exit | Stop | Avoid>",
    "firstShift": "<max 20 words, what the first structural shift to watch for is>",
    "existingHolderAction": "<max 15 words, what existing holders should do>",
    "reEvaluateCondition": "<max 20 words, condition that would trigger re-evaluation>"
  },
  "whatCanChange": ["<max 15 words each, 3-5 catalysts that could shift the current regime>"],
  "strategyViews": {
    "growth": "<max 15 words for momentum managers>",
    "value": "<max 15 words for value investors>"
  },
  "riskAlerts": ["<3-5 words>", "<3-5 words>"],
  "convictionLevel": "<Low | Medium | High>",
  "indicators": [
    { "name": "Market Structure", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words, e.g. Distribution phase>", "explanation": "<max 20 words tooltip explaining this indicator's current state>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Capital Participation", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Price Architecture", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Trend Direction", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Trend Quality", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Momentum", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Volatility", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" },
    { "name": "Relative Strength", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>", "tag": "<2-5 words>", "explanation": "<max 20 words>", "sentiment": "<positive | negative | transitional>" }
  ]
}

Rules:
- tag: 2-5 word alignment summary reflecting whether all indicators agree (e.g. "Full Bearish Alignment") or diverge (e.g. "Mixed Signals")
- lens: "Value" if market bias is bearish and price is below 200 SMA, "Growth" if bullish momentum is present
- idealFor: "Investment" for 6M+ holds, "Positional" for 3-6M, "Swing" for 0-3M
- timeframe: must match idealFor ("Investment"→"6M+", "Positional"→"3-6M", "Swing"→"0-3M")
- actionableInsight.action: "Strong Accumulate" for STRONG_BUY; "Accumulate" for BUY; "Add" for WEAK_BUY; "Neutral" for mild/mixed signals; "Trim" for WEAK_SELL (partial exit in profit); "Cut" for partial exit at loss; "Exit" for STRONG_SELL; "Stop" for stop-loss triggered; "Avoid" for bearish/distribution or insufficient data
- whatCanChange: 3-5 specific catalysts that could shift the regime (e.g. "RSI sustains above 40 — momentum recovery")
- description: max 12 words, no filler
- actionBias: max 25 words, direct imperative tone
- strategyViews.growth and strategyViews.value: max 15 words each, no overlap with actionBias
- riskAlerts: 3-5 items max, each exactly 3-5 words, noun phrases only
- convictionLevel: High if action is "Strong Accumulate" or "Exit" or "Stop"; Medium if "Accumulate", "Add", "Trim", or "Cut"; Low if "Neutral" or "Avoid"
- indicators: always exactly 8 objects in the order above
  - tag: 2-5 word summary of indicator state (e.g. "Distribution phase", "Smart money exiting", "Bearish crossover active")
  - explanation: max 20 words, tooltip text explaining the indicator for a non-expert
  - sentiment: "positive" for bullish signals (green), "negative" for bearish (red), "transitional" for neutral/mixed (orange)
  - growthWatchout and valueWatchout: MUST be a single crisp actionable sentence, max 15 words. Do NOT copy or concatenate the raw watchout text from the input. Instead, synthesize the multiple watchout points into one sharp, original insight. Example: "Monitor volume confirmation before adding positions near breakout."
- CRITICAL: Each watchout must be ONE sentence only. Never join or list multiple points. Distill, don't copy.
- No verbose explanations, no repeating context already stated above
- Return pure JSON only`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full prompt for decision intelligence generation.
 * @param {object} taResult  Full technicalAnalysis.analyze() result
 * @param {string|null} template  DB-stored template (uses PROMPT_TEMPLATE if null)
 */
function decisionIntelligencePrompt(taResult, template) {
  const dataBlock = buildDataBlock(taResult);
  return (template ?? PROMPT_TEMPLATE).replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { decisionIntelligencePrompt, buildDataBlock, PROMPT_TEMPLATE };
