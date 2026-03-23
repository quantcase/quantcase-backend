'use strict';

const openRouter = require('../config/llm');
const { parseJson } = require('./workerUtils');

function na(val) {
  return val != null ? val : 'N/A';
}

function buildContext(result) {
  const re = result.ruleEngine;
  const se = re?.structureEngine;
  const te = re?.trendEngine;
  const ti = re?.timingEngine;
  const de = re?.dominanceEngine?.leadership;

  return {
    symbol:        result.symbol,
    sector:        na(result.meta?.macroSector),
    overallSignal: na(result.signals?.overall),
    score:         na(result.signals?.score),

    wyckoffPhase:               na(se?.marketStructure?.wyckoffPhase),
    marketStructureGrowthOutput: na(se?.marketStructure?.growthOutput),
    marketStructureValueOutput:  na(se?.marketStructure?.valueOutput),
    participation:               na(se?.participation?.growthOutput),
    priceStructure:              na(se?.priceStructure?.growthOutput),

    trendDirectionGrowth:  na(te?.trendDirection?.growthOutput),
    trendDirectionValue:   na(te?.trendDirection?.valueOutput),
    adxCondition:          na(te?.trendQuality?.condition),
    trendQualityGrowth:    na(te?.trendQuality?.growthOutput),
    trendQualityValue:     na(te?.trendQuality?.valueOutput),

    rsiZone:          na(ti?.momentum?.rsiZone),
    momentumGrowth:   na(ti?.momentum?.growthOutput),
    momentumValue:    na(ti?.momentum?.valueOutput),
    bbCondition:      na(ti?.volatility?.condition),
    volatilityGrowth: na(ti?.volatility?.growthOutput),
    volatilityValue:  na(ti?.volatility?.valueOutput),

    vsNiftySignal:  na(de?.vsNifty?.signal),
    vsNiftyGrowth:  na(de?.vsNifty?.growthOutput),
    vsSectorSignal: na(de?.vsSector?.signal),
    vsSectorGrowth: na(de?.vsSector?.growthOutput),

    decisionSummary: na(re?.decisionContext?.summary),
    alerts:          Array.isArray(re?.decisionContext?.alerts)
      ? re.decisionContext.alerts.join(', ')
      : 'N/A',

    wyckoffGrowthWatchouts:       Array.isArray(se?.marketStructure?.growthWatchouts) ? se.marketStructure.growthWatchouts.join(' | ') : 'N/A',
    wyckoffValueWatchouts:        Array.isArray(se?.marketStructure?.valueWatchouts)  ? se.marketStructure.valueWatchouts.join(' | ')  : 'N/A',
    participationGrowthWatchouts: Array.isArray(se?.participation?.growthWatchouts)   ? se.participation.growthWatchouts.join(' | ')   : 'N/A',
    participationValueWatchouts:  Array.isArray(se?.participation?.valueWatchouts)    ? se.participation.valueWatchouts.join(' | ')    : 'N/A',
    priceStructureGrowthWatchouts: Array.isArray(se?.priceStructure?.growthWatchouts) ? se.priceStructure.growthWatchouts.join(' | ') : 'N/A',
    priceStructureValueWatchouts:  Array.isArray(se?.priceStructure?.valueWatchouts)  ? se.priceStructure.valueWatchouts.join(' | ')  : 'N/A',
    adxGrowthWatchouts:           Array.isArray(te?.trendQuality?.growthWatchouts)    ? te.trendQuality.growthWatchouts.join(' | ')   : 'N/A',
    adxValueWatchouts:            Array.isArray(te?.trendQuality?.valueWatchouts)     ? te.trendQuality.valueWatchouts.join(' | ')    : 'N/A',
    rsiGrowthWatchouts:           Array.isArray(ti?.momentum?.growthWatchouts)        ? ti.momentum.growthWatchouts.join(' | ')       : 'N/A',
    rsiValueWatchouts:            Array.isArray(ti?.momentum?.valueWatchouts)         ? ti.momentum.valueWatchouts.join(' | ')        : 'N/A',
  };
}

function buildPrompt(ctx) {
  return `You are a systematic equity analyst. Based on the structured technical analysis below, generate a Decision Intelligence summary in strict JSON.

SYMBOL: ${ctx.symbol} | SECTOR: ${ctx.sector}
OVERALL SIGNAL: ${ctx.overallSignal} (score: ${ctx.score}/100)

=== STRUCTURE ENGINE ===
Wyckoff Phase: ${ctx.wyckoffPhase}
Market Structure (Growth): ${ctx.marketStructureGrowthOutput}
Market Structure (Value): ${ctx.marketStructureValueOutput}
Participation: ${ctx.participation}
Price Structure: ${ctx.priceStructure}

=== TREND ENGINE ===
Trend Direction (Growth): ${ctx.trendDirectionGrowth}
Trend Direction (Value): ${ctx.trendDirectionValue}
Trend Quality (ADX condition: ${ctx.adxCondition}): ${ctx.trendQualityGrowth}
Trend Quality (Value): ${ctx.trendQualityValue}

=== TIMING ENGINE ===
Momentum (RSI zone: ${ctx.rsiZone}): ${ctx.momentumGrowth}
Momentum (Value): ${ctx.momentumValue}
Volatility (BB: ${ctx.bbCondition}): ${ctx.volatilityGrowth}
Volatility (Value): ${ctx.volatilityValue}

=== DOMINANCE ENGINE ===
vs Nifty (${ctx.vsNiftySignal}): ${ctx.vsNiftyGrowth}
vs Sector (${ctx.vsSectorSignal}): ${ctx.vsSectorGrowth}

=== DECISION CONTEXT ===
Summary: ${ctx.decisionSummary}
Risk Alerts: ${ctx.alerts}

=== INDICATOR WATCHOUTS ===
Wyckoff Phase | Growth: ${ctx.wyckoffGrowthWatchouts} | Value: ${ctx.wyckoffValueWatchouts}
Participation | Growth: ${ctx.participationGrowthWatchouts} | Value: ${ctx.participationValueWatchouts}
Price Structure | Growth: ${ctx.priceStructureGrowthWatchouts} | Value: ${ctx.priceStructureValueWatchouts}
Trend Quality (ADX) | Growth: ${ctx.adxGrowthWatchouts} | Value: ${ctx.adxValueWatchouts}
Momentum (RSI) | Growth: ${ctx.rsiGrowthWatchouts} | Value: ${ctx.rsiValueWatchouts}

---
Respond ONLY with a valid JSON object matching this exact schema (no markdown fences, no preamble):
{
  "currentRegime": {
    "label": "<2-4 words, e.g. Strong Uptrend | Sideways Consolidation | Distribution Phase | Oversold Reversal>",
    "description": "<max 12 words, one sharp phrase characterizing the structure>"
  },
  "actionBias": "<max 25 words, one crisp actionable sentence combining growth and value lenses>",
  "strategyViews": {
    "growth": "<max 15 words for momentum managers>",
    "value": "<max 15 words for value investors>"
  },
  "riskAlerts": ["<3-5 words>", "<3-5 words>"],
  "convictionLevel": "<Low | Medium | High>",
  "indicators": [
    { "name": "Wyckoff Phase", "growthWatchout": "<max 15 words, crisp single-line watchout for growth managers>", "valueWatchout": "<max 15 words, crisp single-line watchout for value investors>" },
    { "name": "Participation", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>" },
    { "name": "Price Structure", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>" },
    { "name": "Trend Quality", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>" },
    { "name": "Momentum", "growthWatchout": "<max 15 words>", "valueWatchout": "<max 15 words>" }
  ]
}

Rules:
- description: max 12 words, no filler
- actionBias: max 25 words, direct imperative tone (e.g. "Ride the trend. Take partial profits on overbought RSI.")
- strategyViews.growth and strategyViews.value: max 15 words each, no overlap with actionBias
- riskAlerts: 3-5 items max, each exactly 3-5 words, noun phrases only
- convictionLevel: High if STRONG_BUY or STRONG_SELL, Medium if BUY or SELL, Low otherwise
- indicators: always exactly 5 objects in the order above; each growthWatchout and valueWatchout is a single crisp actionable sentence (max 15 words), distilled from the INDICATOR WATCHOUTS section above
- No verbose explanations, no repeating context already stated above
- Return pure JSON only`;
}

async function callLLM(prompt) {
  const response = await openRouter.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 600,
    temperature: 0,
  });
  return response.choices[0]?.message?.content ?? null;
}

async function generateDecisionIntelligence(result) {
  try {
    if (!result?.ruleEngine) return null;
    const ctx = buildContext(result);
    const prompt = buildPrompt(ctx);
    const text = await callLLM(prompt);
    if (!text) return null;
    return parseJson(text);
  } catch (err) {
    console.error('[decisionIntelligence] LLM call failed:', err.message);
    return null;
  }
}

module.exports = { generateDecisionIntelligence };
