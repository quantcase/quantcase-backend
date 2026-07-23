[Docs](../README.md) · [Specs](../README.md#existing-reference-material) · Technicals Guide

# Technicals Response Guide

> [!NOTE]
> Response-structure design guide for the technicals payload. For the **as-built** backend see
> [../subsystems/technicals-wyckoff.md](../subsystems/technicals-wyckoff.md); for the live frontend
> contract see [../frontend/FRONTEND_TECHNICALS_API.md](../frontend/FRONTEND_TECHNICALS_API.md).

## 1. Top-Level Response Structure
{
  "symbol": "MSUMI",
  "exchange": "NSE",
  "timestamp": "2026-03-22T08:00:00Z",

  "price": {},
  "trend": {},
  "movingAverages": {},
  "momentum": {},
  "volume": {},
  "volatility": {},
  "supportResistance": {},
  "patterns": [],
  "signals": {},
  "timeframes": {},
  "insights": []
}

 Design principles:

Flat but logically grouped
Each block independently computable
Easy caching per block
## 2. Price Block (Raw + Context)
"price": {
  "cmp": 37.2,
  "change": -0.07,
  "changePercent": -0.19,

  "open": 37.3,
  "high": 37.8,
  "low": 36.9,
  "prevClose": 37.27,

  "volume": 1250000,
  "avgVolume20d": 980000,
  "volumeRatio": 1.27,

  "high52w": 53.59,
  "low52w": 28.1,
  "distanceFrom52wHigh": -30.58,
  "distanceFrom52wLow": 32.3
}
## 3. Trend Block (Quant-Based, Not Subjective)
"trend": {
  "direction": "SIDEWAYS", 
  "strength": "WEAK",      
  "adx14": 18.5,

  "structure": {
    "higherHighs": false,
    "higherLows": false
  },

  "phase": "ACCUMULATION"
}
## 4. Moving Averages
"movingAverages": {
  "sma": {
    "20": 36.8,
    "50": 38.5,
    "100": 41.2,
    "200": 45.6
  },
  "ema": {
    "20": 37.0,
    "50": 38.1
  },

  "pricePosition": {
    "aboveSMA20": true,
    "aboveSMA50": false,
    "aboveSMA200": false
  },

  "crossovers": {
    "goldenCross": false,
    "deathCross": false,
    "lastCrossoverDate": null
  }
}
## 5. Momentum Indicators
"momentum": {
  "rsi": {
    "value": 48.2,
    "zone": "NEUTRAL",
    "trend": "RISING"
  },

  "macd": {
    "value": -0.12,
    "signal": -0.15,
    "histogram": 0.03,
    "crossover": "BULLISH"
  },

  "stochastic": {
    "k": 62.4,
    "d": 58.1,
    "signal": "BUY"
  }
}
## 6. Volume Intelligence
"volume": {
  "current": 1250000,
  "avg20": 980000,
  "ratio": 1.27,

  "trend": "INCREASING",

  "signals": {
    "volumeBreakout": true,
    "accumulation": true,
    "distribution": false
  }
}
## 7. Volatility & Bands
"volatility": {
  "atr14": 1.2,

  "bollingerBands": {
    "upper": 39.5,
    "middle": 37.0,
    "lower": 34.5,
    "width": 0.13,
    "squeeze": false
  }
}
## 8. Support / Resistance (Multi-Method)
"supportResistance": {
  "static": {
    "support": [30],
    "resistance": [53]
  },

  "pivotPoints": {
    "pivot": 37.1,
    "r1": 38.2,
    "r2": 39.4,
    "s1": 35.9,
    "s2": 34.8
  },

  "dynamic": {
    "support": ["SMA20"],
    "resistance": ["SMA50", "SMA200"]
  },

  "fibonacci": [34.5, 36.8, 39.2]
}
## 9. Pattern Engine
"patterns": [
  {
    "name": "Wide Consolidation",
    "type": "CONTINUATION",
    "confidence": 0.78,
    "timeframe": "DAILY",
    "breakoutLevel": 53,
    "breakdownLevel": 30
  }
]
## 10. Signal Engine (CORE PRODUCT LAYER)
"signals": {
  "overall": "NEUTRAL",
  "score": 52,

  "timeframeSignals": {
    "shortTerm": "BUY",
    "mediumTerm": "NEUTRAL",
    "longTerm": "SELL"
  },

  "components": {
    "trend": 15,
    "momentum": 20,
    "volume": 10,
    "volatility": 7
  }
}
⏱ 11. Multi-Timeframe (Scalable Design)
"timeframes": {
  "daily": {
    "trend": "SIDEWAYS",
    "signal": "NEUTRAL"
  },
  "weekly": {
    "trend": "DOWN",
    "signal": "SELL"
  },
  "monthly": {
    "trend": "UP",
    "signal": "BUY"
  }
}

 You can later expand each timeframe → full nested object (same schema)

## 12. Insights Layer (LLM / Rules Hybrid)
"insights": [
  "Price trading below 200DMA indicates long-term weakness",
  "RSI rising from neutral suggests early momentum pickup",
  "Volume spike supports accumulation phase",
  "Stock stuck in wide consolidation range (30–53)"
]
## 13. Optional (Enterprise Add-ons)

Add later without breaking schema:

"alerts": [],
"backtest": {},
"risk": {
  "rewardRatio": 2.1,
  "stopLoss": 34.5
},
"metadata": {
  "dataQuality": "HIGH",
  "latencyMs": 120
}
 Key Architectural Decisions
 Separation of concerns
Raw (price)
Derived (indicators)
Interpretation (signals)
Narrative (insights)


Here’s a production-grade signal scoring system you can directly plug into your backend. It’s designed to be:

Deterministic (no black-box surprises)
Explainable (UI-friendly breakdown)
Extensible (you can tune weights later)
Fast (O(n) over indicators)
## 1. Core Idea

You compute normalized sub-scores (0–100) for each pillar:

Trend + Momentum + Volume + Volatility = Final Score (0–100)

Then map score → signal:

0–35   → SELL
35–45  → WEAK SELL
45–55  → NEUTRAL
55–65  → WEAK BUY
65–100 → BUY
## 2. Recommended Weights (Balanced)
{
  "trend": 0.30,
  "momentum": 0.30,
  "volume": 0.20,
  "volatility": 0.20
}

 Why:

Trend + Momentum = core (60%)
Volume confirms
Volatility refines entries
## 3. Trend Score (0–100)
Inputs:
Price vs SMA20/50/200
ADX
Structure (HH/HL)
Formula:
trendScore =
  (priceVsMA_score * 0.5) +
  (adx_score * 0.3) +
  (structure_score * 0.2);
Components:
1. Price vs MAs (0–100)
score = 0;

if (price > SMA20) score += 20;
if (price > SMA50) score += 30;
if (price > SMA200) score += 50;

 Max = 100

2. ADX Score (trend strength)
if (adx < 20) score = 20;
else if (adx < 25) score = 40;
else if (adx < 35) score = 70;
else score = 100;
3. Market Structure
if (higherHighs && higherLows) score = 100;
else if (mixed) score = 50;
else score = 20;
## 4. Momentum Score (0–100)
Inputs:
RSI
MACD
Stochastic
momentumScore =
  (rsi_score * 0.4) +
  (macd_score * 0.4) +
  (stoch_score * 0.2);
RSI Score
if (rsi < 30) score = 80;        // oversold → bullish
else if (rsi < 45) score = 60;
else if (rsi < 55) score = 50;
else if (rsi < 70) score = 70;
else score = 40;                 // overbought risk

 You can boost if RSI trending up:

if (rsiTrend === "RISING") score += 5;
MACD Score
if (macd > signal && histogram > 0) score = 100;
else if (macd > signal) score = 70;
else if (histogram rising) score = 50;
else score = 20;
Stochastic Score
if (k > d && k < 80) score = 80;
else if (k > 80) score = 40;
else if (k < 20) score = 70;
else score = 50;
## 5. Volume Score (0–100)
Inputs:
Volume ratio
Volume trend
Breakout confirmation
volumeScore =
  (volume_ratio_score * 0.5) +
  (volume_trend_score * 0.3) +
  (breakout_score * 0.2);
Volume Ratio
if (ratio > 1.5) score = 100;
else if (ratio > 1.2) score = 80;
else if (ratio > 1.0) score = 60;
else score = 30;
Volume Trend
INCREASING → 80
FLAT       → 50
DECREASING → 20
Breakout Confirmation
if (volumeBreakout) score = 100;
else score = 40;
## 6. Volatility Score (0–100)

 Not directional → measures quality of setup

Inputs:
Bollinger Band width
ATR
Squeeze
volatilityScore =
  (bb_score * 0.5) +
  (atr_score * 0.3) +
  (squeeze_score * 0.2);
BB Width
if (bbWidth < 0.1) score = 90;   // squeeze → breakout potential
else if (bbWidth < 0.2) score = 70;
else score = 40;
ATR (normalized)
if (atrPercent < 2) score = 80;
else if (atrPercent < 4) score = 60;
else score = 40;
Squeeze
true → 100
false → 50
## 7. Final Score
finalScore =
  (trendScore * 0.30) +
  (momentumScore * 0.30) +
  (volumeScore * 0.20) +
  (volatilityScore * 0.20);
## 8. Signal Mapping
function getSignal(score) {
  if (score >= 65) return "BUY";
  if (score >= 55) return "WEAK_BUY";
  if (score >= 45) return "NEUTRAL";
  if (score >= 35) return "WEAK_SELL";
  return "SELL";
}
⏱ 9. Multi-Timeframe Logic

Compute separately for:

Daily
Weekly
Monthly

Then:

overallScore =
  (daily * 0.5) +
  (weekly * 0.3) +
  (monthly * 0.2);
## 10. Insight Generator (Deterministic Rules)

Examples:

if (price < SMA200)
  insights.push("Long-term trend remains weak");

if (rsi rising && macd bullish)
  insights.push("Momentum improving with bullish crossover");

if (volumeBreakout)
  insights.push("Volume confirms potential breakout");