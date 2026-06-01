'use strict';

const prisma = require('../config/prisma');

const newPromptTemplate = `You are a systematic quantitative equity analyst implementing Ajay's rule-based technical analysis framework.

You will receive pre-computed technical indicator data for a stock. Your job is to:
1. Score each of the 7 modules using the exact scoring rules provided
2. Generate plain-language outputs for each engine bucket (NO indicator jargon)
3. Apply playbook classification
4. Produce the complete JSON output

{{DATA_BLOCK}}

---

## SCORING RULES

### MODULE 1 — Structure / Wyckoff + S/R (20 points)

Step 1 — Wyckoff Base Score:
  Markup -> 14 | Re-Accumulation -> 12 | Accumulation -> 11
  Re-Distribution -> 6 | Distribution -> 4 | Markdown -> 0

Ambiguity resolution (apply BEFORE scoring):
  If wyckoff = Distribution AND cmf = Positive AND rs_vs_nifty = Outperforming AND rsi_zone = 50-70 -> treat as Re-Accumulation, set phaseRelabelled = true
  If wyckoff = Re-Distribution AND cmf = Positive AND rs_vs_nifty = Outperforming -> treat as Accumulation, set phaseRelabelled = true

Step 2 — S/R Zone Modifier:
  At Support rank 1 -> +6 | At Support rank 2 -> +5 | At Support rank 3 -> +4
  At Support rank 4 -> +3 | At Support rank 5 -> +2 | Approaching Support -> +4
  Confirmed Breakout -> +3 | Mid Range -> +1 | Approaching Resistance -> 0
  At Resistance -> 0 | Breakdown -> -3

Step 3 — S/R Strength Modifier (use Support Strength proxy and proximity % from input):
  Support Strength = HIGH (proximity < 3%) -> +2
  Resistance Proximity % < 2% AND zone = At Resistance -> -2
  Support Strength = LOW (proximity > 10%) -> -1

Module 1 = Wyckoff base + zone modifier + strength modifier. Cap 20, floor 0.

### MODULE 2 — Trend / SMA Regime (20 points)

Use fundamental_type from input to select scoring column.

Growth scoring:
  Valid cross above SMA_200 (confirmed) -> 18 | Above SMA_200 + SMA_100 (3 days each) -> 16
  Above SMA_200, SMA_100, SMA_50 -> 13 | Full bull stack (above all 4 SMAs, mature) -> 10
  Below SMA_200, above SMA_100 -> 5 | Below SMA_200 and SMA_100 -> 2 | Below all -> 0

Value scoring:
  Returning to SMA_200 from above (within 3%, SMA_200 rising) -> 18
  Valid cross above SMA_200 -> 16 | Above SMA_200 + near SMA_100 (within 5%) -> 13
  Above SMA_200, SMA_100, SMA_50 -> 10 | Above SMA_200 far above (>15%) -> 7
  Below SMA_200 but above SMA_100 -> 8 | Below all -> 2

Mixed scoring:
  Valid cross above SMA_200 -> 17 | Above SMA_200 + SMA_100 -> 14
  Above SMA_200, SMA_100, SMA_50 -> 11 | Full bull stack -> 9
  Below SMA_200, above SMA_100 -> 5 | Below SMA_200 + SMA_100 -> 2 | Below all -> 0

Slope modifier (all types, cap at 20): use SMA_50 Slope from input — Rising -> +1 | Falling -> -1

### MODULE 3 — Momentum / RSI (15 points)

Growth table (RSI zone | direction | vs SMA_100 | BBW | score):
  50-70 | Rising | Above | Any -> 15 | 70-100 | Rising | Above | Rising -> 13
  50-70 | Rising | Above | Falling -> 12 | 70-100 | Rising | Above | Falling -> 10
  50-70 | Falling | Above | Any -> 8 | 30-50 | Rising | Above | Any -> 7
  70-100 | Falling | Any | Any -> 5 | 0-30 | Rising | Above | Any -> 4
  30-50 | Rising | Below | Any -> 4 | 30-50 | Falling | Any | Any -> 3
  0-30 | Rising | Below | Any -> 2 | 0-30 | Falling | Any | Any -> 0

Value table:
  30-50 | Rising | Above | Any -> 15 | 0-30 | Rising | Above | Falling -> 13
  30-50 | Rising | Below | Any -> 11 | 50-70 | Rising | Above | Any -> 10
  0-30 | Rising | Below | Any -> 8 | 30-50 | Falling | Above | Any -> 7
  50-70 | Falling | Above | Any -> 6 | 0-30 | Falling | Above | Any -> 5
  70-100 | Any | Any | Any -> 3 | 0-30 | Falling | Below | Any -> 1

Mixed table:
  50-70 | Rising | Above | Any -> 15 | 50-70 | Rising | Above | Falling -> 12
  30-50 | Rising | Above | Any -> 12 | 0-30 | Rising | Above | Falling -> 10
  70-100 | Rising | Above | Rising -> 9 | 50-70 | Falling | Above | Any -> 8
  30-50 | Falling | Above | Any -> 6 | 70-100 | Falling | Any | Any -> 4
  0-30 | Rising | Below | Any -> 5 | 0-30 | Falling | Any | Any -> 1

### MODULE 4 — Trend Maturity / ADX (15 points, same for all types)
ADX zone | direction | vs SMA_100 | score:
  15-25 | Rising | Above -> 15 | 25-50 | Rising | Above -> 13
  15-25 | Rising | Below -> 11 | 0-15 | Rising | Above -> 9
  25-50 | Falling | Above -> 8 | 15-25 | Falling | Above -> 6
  0-15 | Falling | Any -> 5 | 50-70 | Rising | Above -> 4
  25-50 | Any | Below -> 3 | 50-70 | Falling | Any -> 2
  70-100 | Rising | Any -> 1 | 70-100 | Falling | Any -> 0

### MODULE 5 — Leadership / RS (15 points, same for all types)
Stock vs NIFTY | Stock vs Sector | Sector vs NIFTY | score:
  Out | Out | Out -> 15 | Out | Out | Under -> 12
  Out | Under | Out -> 8 | Under | Out | Under -> 6
  Out | Under | Under -> 5 | Under | Out | Out -> 4
  Under | Under | Out -> 3 | Under | Under | Under -> 0

### MODULE 6 — Capital Flow (10 points)
Growth/Mixed — Volume | CMF | score:
  Above | Positive -> 10 | Below | Positive -> 7 | Above | Negative -> 3 | Below | Negative -> 1

Value — Volume | CMF | score:
  Above | Positive -> 10 | Below | Positive -> 8 | Above | Negative -> 6 | Below | Negative -> 2

### MODULE 7 — Volatility / BBW (5 points, same for all types)
BBW Falling -> 5 | BBW Rising -> 2

---

## SIGNAL COLOUR RULES

Bullish (positive): Wyckoff Markup/Re-Accumulation | Confirmed Breakout | At Support rank 1-2 | Vol Above AND CMF Positive | Full bull stack or valid cross above SMA_200 | ADX 15-25 or 25-50 Rising AND above SMA_100 | RSI 50-70 Rising AND above SMA_100 (Growth) | RSI 30-50 Rising AND above SMA_100 (Value) | BBW Falling | Any CRS Outperforming
Bearish (negative): Wyckoff Distribution/Markdown | S/R Breakdown | Vol Above AND CMF Negative | Below SMA_200 and SMA_100 | ADX 50-70 or 70-100 Falling | RSI 0-30 Falling (Growth) | RSI 70-100 Any (Value) | BBW Rising (late stage) | All 3 CRS Underperforming
Neutral (transitional): all other conditions

---

## PLAYBOOK CLASSIFICATION (evaluate in order, first match wins, only if score >= 55)

EXHAUSTION: ADX 50-70 or 70-100 AND Rising AND BBW Rising AND RSI 70-100 AND Rising -> Ideal: Avoid (Not Suitable)
DISTRIBUTION: wyckoff Distribution AND CMF Negative AND Vol Above AND all 3 CRS Underperforming -> Ideal: Avoid (Not Suitable)
BREAKOUT: S/R Zone = Confirmed Breakout AND wyckoff Markup/Re-Accumulation AND ADX Rising AND >=2 of 3 CRS Outperforming -> Ideal: Swing Entry
PULLBACK: Above SMA_200 (3 days) AND within 3% of SMA_50 or SMA_100 AND RSI 30-50 Rising AND CMF Positive AND >=2 of 3 CRS Outperforming -> Ideal: Positional Add or Swing Entry
BASE BUILDING: wyckoff Accumulation/Re-Accumulation AND ADX 0-15 or 15-25 AND BBW Falling AND above SMA_200 (3 days) -> Ideal: Positional Add or Investor Entry
NO SETUP: score < 55 or no criteria met -> Ideal: Not Suitable

---

## PLAIN LANGUAGE RULES (STRICT — never use CMF, ADX, RSI, BBW, SMA, Wyckoff, CRS, MACD in user-facing text fields)

Translations for user-facing fields (actionableInsight, watchouts, tabSummaries, priorityWatchout, currentRegime.description):
  CMF Positive -> "money flowing in"
  CMF Negative -> "money flowing out"
  Price > SMA 200 -> "above long term average"
  RSI 50-70 Rising -> "momentum building"
  RSI 0-30 -> "deeply oversold"
  RSI 70-100 -> "overbought zone"
  ADX Rising -> "trend gaining strength"
  ADX Falling -> "trend losing strength"
  BBW Falling -> "volatility contracting"
  Vol Above avg -> "strong volume"
  Vol Below avg -> "low volume"
  CRS Outperforming -> "beating the market" or "beating the sector"
  CRS Underperforming -> "lagging the market" or "lagging the sector"
  Wyckoff Markup -> "in uptrend"
  Wyckoff Accumulation -> "being accumulated"
  Wyckoff Distribution -> "being distributed"
  Wyckoff Markdown -> "in downtrend"
  Re-Accumulation -> "trend pausing"
  Re-Distribution -> "trend reversing"
  S/R Breakout -> "breaking above Rs.[level] with volume"
  S/R Breakdown -> "broke below Rs.[level]"
  S/R At Support -> "at support Rs.[level]"

Technical fields (ruleEngine.*) may use concise technical language since they are internal.

---

## PRIORITY WATCHOUT SELECTION

Select the single highest-priority triggered condition:
Priority 1 (Bearish): Breakdown -> "Close below Rs.[level] — support broken." | Distribution confirmed -> "Selling pressure building. Avoid fresh buying." | All 3 CRS falling -> "Underperforming on all fronts. Wait."
Priority 2 (Caution): ADX 50+ Falling -> "Trend exhausting. Trail tighter." | RSI 70+ AND BBW Rising -> "Extended and volatile. Trim positions." | At Resistance AND Vol Below -> "Near resistance, low conviction. Wait for volume."
Priority 3 (Monitor): BBW Falling AND ADX 0-15 -> "Squeeze forming. Watch for breakout direction." | CMF Negative AND Vol Below -> "Low interest. Wait for volume pickup." | RSI 30-50 Falling -> "Momentum fading. Confirm before entry."
Default: watchout from lowest scoring module.

---

## OUTPUT

Respond ONLY with a valid JSON object. No markdown fences, no preamble. Exact field names.

{
  "decisionIntelligence": {
    "tag": "<plain language composite tag from allowed list>",
    "lens": "<Growth|Value|Mixed>",
    "idealFor": "<Swing Entry|Positional Add|Investor Entry|Not Suitable>",
    "playbook": "<Exhaustion|Distribution|Breakout|Pullback|Base Building|No Setup>",
    "timeframe": "<string e.g. '3-6 months'>",
    "convictionLevel": "<Very High|High|Medium|Low|Very Low>",
    "convictionScore": <integer 0-100>,
    "currentRegime": {
      "label": "<plain label, max 4 words>",
      "description": "<1 plain sentence, max 12 words>"
    },
    "priorityWatchout": "<single most critical risk, plain language, max 15 words, Rs. level if relevant>",
    "actionableInsight": {
      "new_position": "<plain language, max 12 words, Rs. level included>",
      "existing_position": "<plain language, partial profit level if applicable>",
      "watch_for": "<plain trigger = plain outcome, max 12 words>"
    },
    "actionableInsight_positional": {
      "new_position": "<positional horizon variant>",
      "existing_position": "<positional horizon variant>",
      "watch_for": "<positional watch>"
    },
    "actionableInsight_investor": {
      "new_position": "<investor horizon variant>",
      "existing_position": "<investor horizon variant>",
      "watch_for": "<investor watch>"
    },
    "whatCanChange": [
      "<plain condition = plain outcome, max 12 words, Rs. level where relevant>",
      "<plain condition = plain outcome, max 12 words>",
      "<plain condition = plain outcome, max 12 words>"
    ],
    "indicators": [
      {
        "name": "<Market Structure|Capital Participation|Price Architecture|Trend Direction|Trend Quality|Momentum|Volatility|Relative Strength>",
        "tab": "<Structure|Trend|Timing|Relative Strength>",
        "tag": "<short plain tag, max 5 words>",
        "sentiment": "<positive|transitional|negative>",
        "explanation": "<1 plain sentence, max 15 words>",
        "growthWatchout": "<1 plain sentence, Rs. level where relevant>",
        "valueWatchout": "<1 plain sentence, Rs. level where relevant>"
      }
    ],
    "ruleEngine": {
      "tabSummaries": {
        "structure": "<max 25 words, plain language, Rs. levels>",
        "trend": "<max 25 words, plain language, Rs. levels>",
        "timing": "<max 25 words, plain language, Rs. levels>",
        "relativeStrength": "<max 25 words, plain language>"
      }
    },
    "levelsToWatch": {
      "immediate": { "price": <float>, "label": "Short term support" },
      "structural": { "price": <float>, "label": "Key support" },
      "regime": { "price": <float>, "label": "Long term average" },
      "horizonNote": "<1 plain sentence with Rs. levels>"
    }
  },

  "ruleEngine": {
    "structureEngine": {
      "marketStructure": {
        "wyckoffPhase": "<phase>",
        "phaseRelabelled": <true|false>,
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "participation": {
        "volumeSignal": "<ABOVE_AVERAGE|BELOW_AVERAGE>",
        "cmfSignal": "<POSITIVE|NEGATIVE>",
        "cmf": <float>,
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "priceStructure": {
        "zone": "<S/R zone label>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      }
    },
    "trendEngine": {
      "trendDirection": {
        "priceVsSMA20": "<ABOVE|BELOW>",
        "priceVsSMA50": "<ABOVE|BELOW>",
        "priceVsSMA100": "<ABOVE|BELOW>",
        "priceVsSMA200": "<ABOVE|BELOW>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "trendQuality": {
        "adx": <float>,
        "adxTrend": "<RISING|FALLING>",
        "adxBand": "<zone>",
        "condition": "<zone & direction>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      }
    },
    "timingEngine": {
      "momentum": {
        "rsi": <float>,
        "rsiZone": "<zone>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "volatility": {
        "bbWidth": <float>,
        "expanding": <true|false>,
        "condition": "<EXPANDING|CONTRACTING>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      }
    },
    "dominanceEngine": {
      "leadership": {
        "vsNifty": {
          "signal": "<OUTPERFORMING|UNDERPERFORMING>",
          "growthOutput": "<plain language, max 15 words>",
          "valueOutput": "<plain language, max 15 words>"
        },
        "vsSector": {
          "signal": "<OUTPERFORMING|UNDERPERFORMING|null>",
          "growthOutput": "<plain language, max 15 words>",
          "valueOutput": "<plain language, max 15 words>"
        }
      }
    }
  },

  "scores": {
    "structure_wyckoff_sr": <int>,
    "trend_sma": <int>,
    "momentum_rsi": <int>,
    "trend_maturity_adx": <int>,
    "leadership_rs": <int>,
    "capital_flow": <int>,
    "volatility_bbw": <int>,
    "final_score": <int>,
    "grade": "<A+|A|B|C|D>",
    "label": "<Leader|Strong|Developing|Weak|Breakdown>"
  }
}

Allowed composite tags (use exactly one):
Strongly Bullish: "Everything Aligned — Strong Buy Signal" | "Breaking Out With Strong Volume" | "Strong Uptrend, Momentum Intact" | "Institutions Accumulating Quietly"
Moderately Bullish: "Healthy Dip In Uptrend" | "Outperforming Market And Sector" | "Building Energy, Breakout Watch" | "Smart Money Quietly Buying" | "Trend Pausing, Watch For Resumption"
Neutral: "Mixed Signals, Wait For Clarity" | "Trading In A Range, No Clear Direction" | "Possible Trend Change, Watch Closely" | "Setup Forming, Not Ready Yet"
Caution: "Uptrend Weakening, Trail Stops" | "Smart Money Exiting, Be Cautious" | "Underperforming, Avoid For Now" | "Testing Key Support Level"
Moderately Bearish: "Below Key Levels, Avoid Fresh Buying" | "Support Broken, High Risk" | "Short Rally In Downtrend, Caution" | "Weak Stock In Weak Sector"
Strongly Bearish: "Everything Bearish, Stay Away" | "Heavy Selling Detected" | "Broken Structure, High Risk"
Special: "Deeply Oversold, Base Building" | "Extremely Extended, Trim Positions" | "Potential Value, But Market Weak"

Conviction score -> convictionLevel: 85-100 = Very High | 70-84 = High | 55-69 = Medium | 40-54 = Low | <40 = Very Low

Indicators array: exactly 8 objects in this order:
  1. Market Structure   (tab: Structure)
  2. Capital Participation (tab: Structure)
  3. Price Architecture  (tab: Structure)
  4. Trend Direction     (tab: Trend)
  5. Trend Quality       (tab: Trend)
  6. Momentum            (tab: Timing)
  7. Volatility          (tab: Timing)
  8. Relative Strength   (tab: Relative Strength)

Return pure JSON only.`;

const newOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'technical_intelligence',
    strict: false,
    schema: {
      type: 'object',
      required: ['decisionIntelligence', 'ruleEngine', 'scores'],
      properties: {

        decisionIntelligence: {
          type: 'object',
          required: [
            'tag', 'lens', 'idealFor', 'timeframe', 'convictionLevel', 'convictionScore',
            'currentRegime', 'priorityWatchout', 'actionableInsight',
            'actionableInsight_positional', 'actionableInsight_investor',
            'whatCanChange', 'indicators', 'ruleEngine', 'levelsToWatch', 'playbook',
          ],
          properties: {
            tag:             { type: 'string' },
            lens:            { type: 'string', enum: ['Growth', 'Value', 'Mixed'] },
            idealFor:        { type: 'string', enum: ['Swing Entry', 'Positional Add', 'Investor Entry', 'Not Suitable'] },
            playbook:        { type: 'string', enum: ['Exhaustion', 'Distribution', 'Breakout', 'Pullback', 'Base Building', 'No Setup'] },
            timeframe:       { type: 'string' },
            convictionLevel: { type: 'string', enum: ['Very High', 'High', 'Medium', 'Low', 'Very Low'] },
            convictionScore: { type: 'integer' },
            currentRegime: {
              type: 'object',
              properties: {
                label:       { type: 'string' },
                description: { type: 'string' },
              },
            },
            priorityWatchout: { type: 'string' },
            actionableInsight: {
              type: 'object',
              properties: {
                new_position:      { type: 'string' },
                existing_position: { type: 'string' },
                watch_for:         { type: 'string' },
              },
            },
            actionableInsight_positional: {
              type: 'object',
              properties: {
                new_position:      { type: 'string' },
                existing_position: { type: 'string' },
                watch_for:         { type: 'string' },
              },
            },
            actionableInsight_investor: {
              type: 'object',
              properties: {
                new_position:      { type: 'string' },
                existing_position: { type: 'string' },
                watch_for:         { type: 'string' },
              },
            },
            whatCanChange: { type: 'array', items: { type: 'string' } },
            indicators: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:           { type: 'string' },
                  tab:            { type: 'string', enum: ['Structure', 'Trend', 'Timing', 'Relative Strength'] },
                  tag:            { type: 'string' },
                  sentiment:      { type: 'string', enum: ['positive', 'negative', 'transitional'] },
                  explanation:    { type: 'string' },
                  growthWatchout: { type: 'string' },
                  valueWatchout:  { type: 'string' },
                },
              },
            },
            ruleEngine: {
              type: 'object',
              properties: {
                tabSummaries: {
                  type: 'object',
                  properties: {
                    structure:        { type: 'string' },
                    trend:            { type: 'string' },
                    timing:           { type: 'string' },
                    relativeStrength: { type: 'string' },
                  },
                },
              },
            },
            levelsToWatch: {
              type: 'object',
              properties: {
                immediate:   { type: 'object', properties: { price: { type: 'number' }, label: { type: 'string' } } },
                structural:  { type: 'object', properties: { price: { type: 'number' }, label: { type: 'string' } } },
                regime:      { type: 'object', properties: { price: { type: 'number' }, label: { type: 'string' } } },
                horizonNote: { type: 'string' },
              },
            },
          },
        },

        ruleEngine: {
          type: 'object',
          properties: {
            structureEngine: {
              type: 'object',
              properties: {
                marketStructure: {
                  type: 'object',
                  properties: {
                    wyckoffPhase:    { type: 'string' },
                    phaseRelabelled: { type: 'boolean' },
                    growthOutput:    { type: 'string' },
                    valueOutput:     { type: 'string' },
                  },
                },
                participation: {
                  type: 'object',
                  properties: {
                    volumeSignal: { type: 'string', enum: ['ABOVE_AVERAGE', 'BELOW_AVERAGE'] },
                    cmfSignal:    { type: 'string', enum: ['POSITIVE', 'NEGATIVE'] },
                    cmf:          { type: 'number' },
                    growthOutput: { type: 'string' },
                    valueOutput:  { type: 'string' },
                  },
                },
                priceStructure: {
                  type: 'object',
                  properties: {
                    zone:         { type: 'string' },
                    growthOutput: { type: 'string' },
                    valueOutput:  { type: 'string' },
                  },
                },
              },
            },
            trendEngine: {
              type: 'object',
              properties: {
                trendDirection: {
                  type: 'object',
                  properties: {
                    priceVsSMA20:  { type: 'string', enum: ['ABOVE', 'BELOW'] },
                    priceVsSMA50:  { type: 'string', enum: ['ABOVE', 'BELOW'] },
                    priceVsSMA100: { type: 'string', enum: ['ABOVE', 'BELOW'] },
                    priceVsSMA200: { type: 'string', enum: ['ABOVE', 'BELOW'] },
                    growthOutput:  { type: 'string' },
                    valueOutput:   { type: 'string' },
                  },
                },
                trendQuality: {
                  type: 'object',
                  properties: {
                    adx:          { type: 'number' },
                    adxTrend:     { type: 'string', enum: ['RISING', 'FALLING'] },
                    adxBand:      { type: 'string' },
                    condition:    { type: 'string' },
                    growthOutput: { type: 'string' },
                    valueOutput:  { type: 'string' },
                  },
                },
              },
            },
            timingEngine: {
              type: 'object',
              properties: {
                momentum: {
                  type: 'object',
                  properties: {
                    rsi:          { type: 'number' },
                    rsiZone:      { type: 'string' },
                    growthOutput: { type: 'string' },
                    valueOutput:  { type: 'string' },
                  },
                },
                volatility: {
                  type: 'object',
                  properties: {
                    bbWidth:      { type: 'number' },
                    expanding:    { type: 'boolean' },
                    condition:    { type: 'string', enum: ['EXPANDING', 'CONTRACTING'] },
                    growthOutput: { type: 'string' },
                    valueOutput:  { type: 'string' },
                  },
                },
              },
            },
            dominanceEngine: {
              type: 'object',
              properties: {
                leadership: {
                  type: 'object',
                  properties: {
                    vsNifty: {
                      type: 'object',
                      properties: {
                        signal:       { type: 'string', enum: ['OUTPERFORMING', 'UNDERPERFORMING'] },
                        growthOutput: { type: 'string' },
                        valueOutput:  { type: 'string' },
                      },
                    },
                    vsSector: {
                      type: 'object',
                      properties: {
                        signal:       { type: ['string', 'null'] },
                        growthOutput: { type: 'string' },
                        valueOutput:  { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        scores: {
          type: 'object',
          required: [
            'structure_wyckoff_sr', 'trend_sma', 'momentum_rsi', 'trend_maturity_adx',
            'leadership_rs', 'capital_flow', 'volatility_bbw', 'final_score', 'grade', 'label',
          ],
          properties: {
            structure_wyckoff_sr: { type: 'integer' },
            trend_sma:            { type: 'integer' },
            momentum_rsi:         { type: 'integer' },
            trend_maturity_adx:   { type: 'integer' },
            leadership_rs:        { type: 'integer' },
            capital_flow:         { type: 'integer' },
            volatility_bbw:       { type: 'integer' },
            final_score:          { type: 'integer' },
            grade:                { type: 'string', enum: ['A+', 'A', 'B', 'C', 'D'] },
            label:                { type: 'string', enum: ['Leader', 'Strong', 'Developing', 'Weak', 'Breakdown'] },
          },
        },

      },
    },
  },
};

prisma.skill.update({
  where: { slug: 'technical-intelligence' },
  data: {
    promptTemplate: newPromptTemplate,
    outputSchema:   newOutputSchema,
    maxTokens:      10000,
  },
})
  .then((s) => {
    console.log('OK — skill updated');
    console.log('  maxTokens:          ', s.maxTokens);
    console.log('  promptTemplate len: ', s.promptTemplate.length, 'chars');
    console.log('  outputSchema keys:  ', Object.keys(s.outputSchema?.json_schema?.schema?.properties ?? {}));
  })
  .catch((e) => console.error('ERROR:', e))
  .finally(() => prisma.$disconnect());
