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
  "convictionLevel": "<Low | Medium | High>"
}

Rules:
- description: max 12 words, no filler
- actionBias: max 25 words, direct imperative tone (e.g. "Ride the trend. Take partial profits on overbought RSI.")
- strategyViews.growth and strategyViews.value: max 15 words each, no overlap with actionBias
- riskAlerts: 3-5 items max, each exactly 3-5 words, noun phrases only
- convictionLevel: High if STRONG_BUY or STRONG_SELL, Medium if BUY or SELL, Low otherwise
- No verbose explanations, no repeating context already stated above
- Return pure JSON only`;
}

async function callLLM(prompt) {
  const response = await openRouter.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
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
