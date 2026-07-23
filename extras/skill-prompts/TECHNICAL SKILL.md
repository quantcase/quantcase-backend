---
name: quant-technical-analysis
description: >
  Run Ajay's rule-based quantitative technical analysis framework on a single stock.
  Use this skill whenever the user provides OHLCV data (or a stock with pre-computed
  inputs) and asks for technical analysis, a technical score, a playbook recommendation,
  entry/exit conditions, or a go/no-go technical decision. Also trigger when the user
  says "analyse this stock", "run the framework", "what does the technical say",
  "give me the technical view", or "run rule engine". This skill computes all indicators,
  scores across 7 modules, generates bucket tags with signal colours, composite tag,
  rule engine tab output, actionable insight, priority watchout, ideal for, levels to
  watch, conviction meter, and what can change. All output is in plain language —
  no indicator jargon anywhere.
---

# Quant Technical Analysis Skill

A deterministic, rule-based technical analysis engine for single-stock research.
Designed for daily timeframe. Two lenses: Fundamental Type x Time Horizon.

Read reference files when needed:
- `references/indicator-formulas.md` — full computation details
- `references/bucket-tags.md` — all bucket-level tags, colours, watchouts
- `references/composite-tags.md` — composite tag classification + plain language names
- `references/scoring-examples.md` — scored walk-throughs

---

## Input Contract

Ask for missing inputs before proceeding.

```
REQUIRED:
- OHLCV data:          daily candles, minimum 200 days
- wyckoff_phase:       Accumulation | Markup | Re-Accumulation |
                       Distribution | Re-Distribution | Markdown
- rs_stock_vs_nifty:   float (7 EMA smoothed CRS, daily)
- rs_stock_vs_sector:  float (7 EMA smoothed CRS, daily)
- rs_sector_vs_nifty:  float (7 EMA smoothed CRS, daily)
- support_levels:      list of up to 5 → { price, strength_score: 0-100 }
                       ordered by strength_score descending
- resistance_levels:   list of up to 5 → { price, strength_score: 0-100 }
                       ordered by strength_score descending
- fundamental_type:    Growth | Value | Mixed
- time_horizon:        Swing | Positional | Investor
```

---

## Step 1: Compute Indicators

### SMAs
```
SMA_20  = mean(close, 20)
SMA_50  = mean(close, 50)
SMA_100 = mean(close, 100)
SMA_200 = mean(close, 200)
SMA_50_slope: Rising if SMA_50[today] > SMA_50[10 days ago], else Falling
```

### RSI — 14 period, Wilder's Smoothing
```
Day 1-14:  avg_gain = mean(gains), avg_loss = mean(losses)
Day 15+:   avg_gain = (avg_gain_prev x 13 + gain_today) / 14
RSI = 100 - (100 / (1 + avg_gain / avg_loss))
RSI_zone:      0-30 | 30-50 | 50-70 | 70-100
RSI_direction: Rising if RSI[today] > RSI[3 days ago], else Falling
```

### ADX — 14 period, Wilder's method
```
Standard Wilder ADX (see references/indicator-formulas.md)
ADX_zone:      0-15 | 15-25 | 25-50 | 50-70 | 70-100
ADX_direction: Rising if ADX[today] > ADX[3 days ago], else Falling
Note: +DI / -DI not used
```

### Bollinger Band Width
```
BB_Width = (BB_Upper - BB_Lower) / SMA_20
BB_Width_Percentile = rank of today's BB_Width over last 252 days (0-100)
BBW_direction: Rising if BBW[today] > BBW[yesterday], else Falling
```

### Volume
```
Vol_30D_Avg = mean(volume, 30)
Vol_signal: Above if volume[today] > Vol_30D_Avg, else Below
```

### CMF — 20 period
```
MFM = ((close - low) - (high - close)) / (high - low)  [0 if high = low]
CMF = sum(MFM x volume, 20) / sum(volume, 20)
CMF_signal: Positive if CMF > 0, else Negative
```

### SMA Confirmation Rule
```
"Price holds above SMA_X" = price > SMA_X for 3 consecutive days

Valid SMA_200 cross =
  crossed above in last 5 days
  AND price > SMA_200 x 1.015
  AND no cross below SMA_200 in prior 10 days
  AND close > open on crossover candle
```

### RS Direction
```
Outperforming:   CRS[today] > CRS[yesterday]
Underperforming: CRS[today] < CRS[yesterday]
```

### S/R Derived Fields
```
strongest_support    = support_levels[0]
strongest_resistance = resistance_levels[0]
nearest_support      = support level closest below current_price
nearest_resistance   = resistance level closest above current_price

support_proximity_pct    = (price - nearest_support.price) / price x 100
resistance_proximity_pct = (nearest_resistance.price - price) / price x 100

Breakout detection:
  breakout_level = resistance where price > level.price x 1.02
                   AND Vol_signal = Above
                   AND crossover within last 5 candles
  breakout_quality:
    High Conviction: breakout_level = resistance_levels[0]
    Moderate:        breakout_level = resistance_levels[1-2]
    Weak:            breakout_level = resistance_levels[3-4]

S/R Zone:
  Breakdown:              price < nearest_support.price x 0.98
  At Support:             price within +/-2% of nearest_support.price
  Approaching Support:    price 2-10% above nearest_support.price
  Mid Range:              >10% above support AND >10% below resistance
  Approaching Resistance: price 2-10% below nearest_resistance.price
  At Resistance:          price within +/-2% of nearest_resistance.price
  Confirmed Breakout:     price > nearest_resistance.price x 1.02 AND Vol = Above
```

---

## Step 2: Score Each Module

Total = 100. S/R integrated into Module 1.

---

### MODULE 1 — Structure / Wyckoff + S/R (20 points)

#### Ambiguity Resolution (run first)
```
If wyckoff = Distribution AND CMF = Positive AND rs_stock_nifty = Outperforming
  AND RSI_zone = 50-70:
  treat as Re-Accumulation. Flag: "Phase relabelled"

If wyckoff = Re-Distribution AND CMF = Positive AND rs_stock_nifty = Outperforming:
  treat as Accumulation. Flag: "Phase relabelled"
```

#### Step 1: Wyckoff Base Score
| Wyckoff Phase | Score |
|---|---|
| Markup | 14 |
| Re-Accumulation | 12 |
| Accumulation | 11 |
| Re-Distribution | 6 |
| Distribution | 4 |
| Markdown | 0 |

#### Step 2: S/R Zone Modifier
| S/R Zone | Modifier |
|---|---|
| At Support — rank 1 (strongest) | +6 |
| At Support — rank 2 | +5 |
| At Support — rank 3 | +4 |
| At Support — rank 4 | +3 |
| At Support — rank 5 | +2 |
| Approaching Support | +4 |
| Confirmed Breakout | +3 |
| Mid Range | +1 |
| Approaching Resistance | 0 |
| At Resistance | 0 |
| Breakdown | -3 |

#### Step 3: S/R Strength Modifier
```
strongest_support.strength >= 70 AND support_proximity_pct < 3%:  +2
strongest_resistance.strength >= 70 AND resistance_proximity_pct < 2%: -2
strongest_support.strength <= 30: -1
```

```
Module 1 = Wyckoff base + S/R zone + S/R strength modifier
Cap at 20. Floor at 0.
```

---

### MODULE 2 — Trend / SMA Regime (20 points)

#### Growth
```
Valid cross above SMA_200 (confirmed):                         18
Holds above SMA_200 AND SMA_100 (3 days each):                 16
Holds above SMA_200, SMA_100, SMA_50:                          13
Holds above all 4 SMAs (full bull stack — mature):             10
Below SMA_200, holds above SMA_100:                             5
Below SMA_200 and SMA_100:                                      2
Below all SMAs:                                                  0
```
Note Growth: Full bull stack = 10 (mature). Fresh cross above SMA_200 = 18 (highest).

#### Value
```
Returning to SMA_200 from above (within 3%, SMA_200 rising):   18
Valid cross above SMA_200 (confirmed):                          16
Above SMA_200 AND near SMA_100 (within 5%):                    13
Above SMA_200, SMA_100, SMA_50:                                10
Above SMA_200 only, far above (>15%):                           7
Below SMA_200 but above SMA_100:                                8
Below all SMAs:                                                  2
```
Note Value: Near SMA_200 = opportunity. Far above = extended.

#### Mixed
```
Valid cross above SMA_200:                                      17
Above SMA_200 AND SMA_100:                                      14
Above SMA_200, SMA_100, SMA_50:                                 11
Full bull stack:                                                  9
Below SMA_200, above SMA_100:                                    5
Below SMA_200 and SMA_100:                                       2
Below all SMAs:                                                   0
```

#### Slope Modifier (all types, cap at 20)
```
SMA_50_slope Rising:  +1
SMA_50_slope Falling: -1
```

---

### MODULE 3 — Momentum / RSI (15 points)

Confirmed by: Price vs SMA_100 (3-day hold) + BBW_direction

#### Growth
| RSI Zone | Direction | vs SMA_100 | BBW | Score |
|---|---|---|---|---|
| 50-70 | Rising | Above | Any | 15 |
| 70-100 | Rising | Above | Rising | 13 |
| 50-70 | Rising | Above | Falling | 12 |
| 70-100 | Rising | Above | Falling | 10 |
| 50-70 | Falling | Above | Any | 8 |
| 30-50 | Rising | Above | Any | 7 |
| 70-100 | Falling | Any | Any | 5 |
| 0-30 | Rising | Above | Any | 4 |
| 30-50 | Rising | Below | Any | 4 |
| 30-50 | Falling | Any | Any | 3 |
| 0-30 | Rising | Below | Any | 2 |
| 0-30 | Falling | Any | Any | 0 |

#### Value
| RSI Zone | Direction | vs SMA_100 | BBW | Score |
|---|---|---|---|---|
| 30-50 | Rising | Above | Any | 15 |
| 0-30 | Rising | Above | Falling | 13 |
| 30-50 | Rising | Below | Any | 11 |
| 50-70 | Rising | Above | Any | 10 |
| 0-30 | Rising | Below | Any | 8 |
| 30-50 | Falling | Above | Any | 7 |
| 50-70 | Falling | Above | Any | 6 |
| 0-30 | Falling | Above | Any | 5 |
| 70-100 | Any | Any | Any | 3 |
| 0-30 | Falling | Below | Any | 1 |

#### Mixed
| RSI Zone | Direction | vs SMA_100 | BBW | Score |
|---|---|---|---|---|
| 50-70 | Rising | Above | Any | 15 |
| 50-70 | Rising | Above | Falling | 12 |
| 30-50 | Rising | Above | Any | 12 |
| 0-30 | Rising | Above | Falling | 10 |
| 70-100 | Rising | Above | Rising | 9 |
| 50-70 | Falling | Above | Any | 8 |
| 30-50 | Falling | Above | Any | 6 |
| 70-100 | Falling | Any | Any | 4 |
| 0-30 | Rising | Below | Any | 5 |
| 0-30 | Falling | Any | Any | 1 |

---

### MODULE 4 — Trend Maturity / ADX (15 points)

Same for all types. No DI used.

| ADX Zone | Direction | vs SMA_100 | Score |
|---|---|---|---|
| 15-25 | Rising | Above | 15 |
| 25-50 | Rising | Above | 13 |
| 15-25 | Rising | Below | 11 |
| 0-15 | Rising | Above | 9 |
| 25-50 | Falling | Above | 8 |
| 15-25 | Falling | Above | 6 |
| 0-15 | Falling | Any | 5 |
| 50-70 | Rising | Above | 4 |
| 25-50 | Any | Below | 3 |
| 50-70 | Falling | Any | 2 |
| 70-100 | Rising | Any | 1 |
| 70-100 | Falling | Any | 0 |

---

### MODULE 5 — Leadership / RS (15 points)

Same for all types.

| Stock vs NIFTY | Stock vs Sector | Sector vs NIFTY | Score |
|---|---|---|---|
| Outperforming | Outperforming | Outperforming | 15 |
| Outperforming | Outperforming | Underperforming | 12 |
| Outperforming | Underperforming | Outperforming | 8 |
| Underperforming | Outperforming | Underperforming | 6 |
| Outperforming | Underperforming | Underperforming | 5 |
| Underperforming | Outperforming | Outperforming | 4 |
| Underperforming | Underperforming | Outperforming | 3 |
| Underperforming | Underperforming | Underperforming | 0 |

---

### MODULE 6 — Capital Flow (10 points)

#### Growth and Mixed
| Volume | CMF | Score |
|---|---|---|
| Above | Positive | 10 |
| Below | Positive | 7 |
| Above | Negative | 3 |
| Below | Negative | 1 |

#### Value
| Volume | CMF | Score |
|---|---|---|
| Above | Positive | 10 |
| Below | Positive | 8 |
| Above | Negative | 6 |
| Below | Negative | 2 |

---

### MODULE 7 — Volatility / BBW (5 points)

Same for all types.

| BBW Direction | Score |
|---|---|
| Falling | 5 |
| Rising | 2 |

---

## Step 3: Final Score

```
final_score = sum(modules 1-7)
final_score = min(100, max(0, final_score))
```

Note: S/R is fully integrated into Module 1. Total max = 100.

---

## Step 4: Score Classification

| Score | Grade | Label | Decision |
|---|---|---|---|
| 85-100 | A+ | Leader | GO — High Conviction |
| 70-84 | A | Strong | GO |
| 55-69 | B | Developing | WATCH |
| 40-54 | C | Weak | WATCH |
| < 40 | D | Breakdown | NO-GO |

---

## Step 5: Bucket Tags + Signal Colour

Read `references/bucket-tags.md` for full rules.
Apply plain language translations — never use raw indicator names in output.

### Tab Groupings
```
STRUCTURE tab:          Wyckoff + S/R Zone + Volume + CMF
TREND tab:              SMA Regime + ADX
TIMING tab:             RSI + BBW
RELATIVE STRENGTH tab:  CRS Stock vs NIFTY + CRS Stock vs Sector + CRS Sector vs NIFTY
```

### Per Bucket Output
```
bucket_name:         <n>
tab:                 Structure | Trend | Timing | Relative Strength
signal_colour:       Bullish | Neutral | Bearish
interpretation_tag:  <short plain label — max 5 words>
output:              <1 sentence, plain language, max 15 words>
watchout:            <1 sentence, plain language, includes Rs. level where relevant>
```

### Signal Colour Rules
```
Bullish (green):
  Wyckoff = Markup or Re-Accumulation
  S/R Zone = Confirmed Breakout or At Support (rank 1-2)
  Vol = Above AND CMF = Positive
  SMA = full bull stack or valid cross above SMA_200
  ADX = 15-25 or 25-50 Rising AND above SMA_100
  RSI = 50-70 Rising AND above SMA_100 (Growth)
  RSI = 30-50 Rising AND above SMA_100 (Value)
  BBW = Falling
  Any CRS = Outperforming

Bearish (red):
  Wyckoff = Distribution or Markdown
  S/R Zone = Breakdown
  Vol = Above AND CMF = Negative
  SMA = below SMA_200 and SMA_100
  ADX = 50-70 or 70-100 Falling
  RSI = 0-30 Falling (Growth) | 70-100 Any (Value)
  BBW = Rising (late stage)
  All 3 CRS = Underperforming

Neutral (yellow): all other conditions
```

### Rule Engine Tab Summary
Each tab has a summary line shown immediately below the tab bar.
Max 2 lines. Max 25 words. Plain language. Includes price levels.

```
Generate summary by combining signals from that tab's buckets.
Example Structure summary:
  "Smart money buying dips. Money flowing in. Price approaching
   Rs.10,000 — wait for breakout or pullback."
```

---

## Step 6: Composite Tag

Read `references/composite-tags.md`. Select ONE tag.
ALWAYS use the Plain Language Tag. Never use the technical name.

Plain language tags:
- Strongly Bullish:    Everything Aligned — Strong Buy Signal |
                       Breaking Out With Strong Volume |
                       Strong Uptrend, Momentum Intact |
                       Institutions Accumulating Quietly
- Moderately Bullish:  Healthy Dip In Uptrend |
                       Outperforming Market And Sector |
                       Building Energy, Breakout Watch |
                       Smart Money Quietly Buying |
                       Trend Pausing, Watch For Resumption
- Neutral/Wait:        Mixed Signals, Wait For Clarity |
                       Trading In A Range, No Clear Direction |
                       Possible Trend Change, Watch Closely |
                       Setup Forming, Not Ready Yet
- Caution:             Uptrend Weakening, Trail Stops |
                       Smart Money Exiting, Be Cautious |
                       Underperforming, Avoid For Now |
                       Testing Key Support Level
- Moderately Bearish:  Below Key Levels, Avoid Fresh Buying |
                       Support Broken, High Risk |
                       Short Rally In Downtrend, Caution |
                       Weak Stock In Weak Sector
- Strongly Bearish:    Everything Bearish, Stay Away |
                       Heavy Selling Detected |
                       Broken Structure, High Risk
- Special:             Deeply Oversold, Base Building |
                       Extremely Extended, Trim Positions |
                       Potential Value, But Market Weak

---

## Step 7: Decision Box

### Ideal For (primary + dropdown options)
```
Primary (default shown):
  Breakout + score 70+:         "Swing Entry"
  Pullback + score 70+:         "Positional Add" (default) or "Swing Entry"
  Base Building + score 55+:    "Positional Add" or "Investor Entry"
  Score < 55:                   "Not Suitable"

Dropdown options always available:
  Positional | Investor
  Each selection changes actionable insight blocks
```

### Priority Watchout
```
Select highest priority triggered condition — one sentence only.

Priority 1 (Bearish):
  Breakdown → "Close below Rs.[level] — support broken."
  Distribution confirmed → "Selling pressure building. Avoid fresh buying."
  All 3 CRS falling → "Underperforming on all fronts. Wait."

Priority 2 (Caution):
  ADX 50+ Falling → "Trend exhausting. Trail tighter."
  RSI 70+ AND BBW Rising → "Extended and volatile. Trim positions."
  At Resistance AND Vol Below → "Near resistance, low conviction. Wait for volume."

Priority 3 (Monitor):
  BBW Falling AND ADX 0-15 → "Squeeze forming. Watch for breakout direction."
  CMF Negative AND Vol Below → "Low interest. Wait for volume pickup."
  RSI 30-50 Falling → "Momentum fading. Confirm before entry."

Default: watchout from lowest scoring module.
```

---

## Step 8: Playbook Classification

Evaluate in order. First match wins. Only classify if score >= 55.

### EXHAUSTION
```
Trigger: ADX_zone = 50-70 or 70-100 AND ADX_direction = Rising
         AND BBW_direction = Rising
         AND RSI_zone = 70-100 AND RSI_direction = Rising
Ideal For: Avoid
```

### DISTRIBUTION
```
Trigger: wyckoff = Distribution (confirmed)
         AND CMF = Negative AND Vol = Above
         AND all 3 CRS = Underperforming
Ideal For: Avoid
```

### BREAKOUT
```
Trigger: S/R Zone = Confirmed Breakout
         AND wyckoff = Markup or Re-Accumulation
         AND ADX_direction = Rising
         AND at least 2 of 3 CRS = Outperforming
Quality:
  High Conviction: 70-100%
  Moderate:        50-70%
  Weak:            20-30%
Ideal For: Swing Entry
```

### PULLBACK
```
Trigger: Holds above SMA_200 (3 days)
         AND price within 3% of SMA_50 or SMA_100
         AND RSI_zone = 30-50 AND RSI_direction = Rising
         AND CMF = Positive
         AND at least 2 of 3 CRS = Outperforming
Ideal For: Positional Add | Swing Entry (per horizon)
```

### BASE BUILDING
```
Trigger: wyckoff = Accumulation or Re-Accumulation
         AND ADX_zone = 0-15 or 15-25
         AND BBW_direction = Falling
         AND holds above SMA_200 (3 days)
Ideal For: Positional Add | Investor Entry (per horizon)
```

### NO SETUP
```
Score < 55 or no criteria met.
Ideal For: Watch Only | Not Suitable
```

---

## Step 9: Levels to Watch

Always output 3 levels.

```
Immediate:   nearest_support.price    (short term reaction zone)
Structural:  strongest_support.price  (key decision level)
Regime:      SMA_200                  (bull/bear line)
```

Horizon note (one sentence, plain language, includes Rs. levels):
```
Swing:      "Break below Rs.[immediate] = exit setup."
Positional: "Close below Rs.[structural] = reassess position."
Investor:   "Break below Rs.[regime] = structural change."
```

---

## Step 10: Conviction Meter

```
85-100: Very High
70-84:  High
55-69:  Medium
40-54:  Low
< 40:   Very Low
```

---

## Step 11: Actionable Insight

### Language Rules — STRICT
```
Never use: CMF, ADX, RSI, BBW, SMA, Wyckoff, CRS, MACD
           or any indicator abbreviation in user-facing text.

Always use plain equivalents:
  CMF Positive        → "money flowing in"
  CMF Negative        → "money flowing out"
  Price > SMA 50      → "price above 50 MA"
  Price > SMA 200     → "price above long term average"
  RSI 50-70 Rising    → "momentum building"
  RSI 0-30            → "deeply oversold"
  RSI 70-100          → "overbought zone"
  ADX Rising          → "trend gaining strength"
  ADX Falling         → "trend losing strength"
  BBW Falling         → "volatility contracting"
  Vol Above avg       → "strong volume" or "volume picking up"
  Vol Below avg       → "low volume" or "low interest"
  CRS Outperforming   → "beating the market" or "beating the sector"
  CRS Underperforming → "lagging the market" or "lagging the sector"
  Wyckoff Markup      → "in uptrend"
  Wyckoff Accumulation → "being accumulated"
  Wyckoff Distribution → "being distributed"
  Wyckoff Markdown    → "in downtrend"
  Re-Accumulation     → "trend pausing"
  Re-Distribution     → "trend reversing"
  S/R Breakout        → "breaking above Rs.[level] with volume"
  S/R Breakdown       → "broke below Rs.[level]"
  S/R At Support      → "at support Rs.[level]"
```

### Format — Two lines + one watch line. No toggle.
```
New:     [Action]. [Plain reason in 5-7 words]. [Entry level if applicable].
Hold:    [Action]. [Plain reason]. [Partial profit level if applicable].
Watch:   [Plain trigger] = [plain outcome].

Max 12 words per line. Price levels mandatory where relevant.
```

### Generation Rules by Score
```
Score 70+:
  New:   "Buy on pullback to Rs.[nearest_support or SMA level]."
  Hold:  "Hold. Trail above Rs.[immediate level]. Trim near Rs.[resistance]."
  Watch: "[Plain condition] = add more."

Score 55-69:
  New:   "Wait. [Plain primary reason]. No entry yet."
  Hold:  "Hold cautiously. Trail above Rs.[level]."
  Watch: "[Plain condition] = entry signal."

Score < 55:
  New:   "Avoid. [Plain primary risk]. No entry."
  Hold:  "Reduce. Exit if price breaks Rs.[structural level]."
  Watch: "[Plain condition] = reassess."
```

### Per Horizon Variant (triggered by dropdown selection)
```
Swing:
  New:   Entry near Rs.[SMA_50 or nearest support]. Tight trail.
  Hold:  Trail above Rs.[SMA_50]. Trim 30-40% near resistance.
  Watch: Momentum drops = exit quickly.

Positional:
  New:   Enter near Rs.[SMA_50 or SMA_100]. Add on breakout.
  Hold:  Trail above Rs.[SMA_100]. Book 20-25% near resistance.
  Watch: Breaks below Rs.[SMA_100] = reduce.

Investor:
  New:   Accumulate near Rs.[strongest_support]. Add in parts.
  Hold:  Hold long term. Trim 10-15% near strong resistance.
  Watch: Breaks below Rs.[SMA_200] = reassess thesis.
```

### What Can Change (2-3 bullets)
```
Identify 2-3 lowest scoring modules.
Format: "[Plain condition] = [plain outcome]."
Max 12 words per bullet. Includes Rs. levels.
Example: "Breaks above Rs.10,000 with volume = add more."
         "Money flow turns negative = reduce exposure."
         "Momentum drops below midpoint = slow down buying."
```

---

## Step 12: Full JSON Output

Map exactly to these field names (matches backend API structure):

```json
{
  "decisionIntelligence": {
    "tag": "<plain language composite tag>",
    "lens": "Growth|Value|Mixed",
    "idealFor": "Swing Entry|Positional Add|Investor Entry|Not Suitable",
    "timeframe": "<string>",
    "convictionLevel": "Very High|High|Medium|Low|Very Low",
    "convictionScore": <int>,

    "actionableInsight": {
      "new_position": "<plain language. max 12 words. includes Rs. level.>",
      "existing_position": "<plain language. includes partial profit level.>",
      "watch_for": "<plain trigger = plain outcome. max 12 words.>"
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
      "<plain condition = plain outcome. max 12 words.>",
      "<plain condition = plain outcome. max 12 words.>",
      "<plain condition = plain outcome. max 12 words.>"
    ],

    "indicators": [
      {
        "name": "Market Structure|Capital Participation|Price Architecture|Trend Direction|Trend Quality|Momentum|Volatility|Relative Strength",
        "tab": "Structure|Trend|Timing|Relative Strength",
        "tag": "<short plain tag — max 5 words>",
        "sentiment": "positive|transitional|negative",
        "explanation": "<1 sentence, plain language, max 15 words>",
        "growthWatchout": "<1 sentence, plain language, Rs. level included>",
        "valueWatchout": "<1 sentence, plain language, Rs. level included>"
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

    "currentRegime": {
      "label": "<plain label>",
      "description": "<1 sentence plain description>"
    },

    "priorityWatchout": "<single most critical risk. plain language. max 15 words.>",

    "levelsToWatch": {
      "immediate": { "price": <float>, "label": "Short term support" },
      "structural": { "price": <float>, "label": "Key support" },
      "regime": { "price": <float>, "label": "Long term average" },
      "horizonNote": "<1 sentence plain language>"
    }
  },

  "ruleEngine": {
    "structureEngine": {
      "marketStructure": {
        "wyckoffPhase": "<phase>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "participation": {
        "volumeSignal": "ABOVE_AVERAGE|BELOW_AVERAGE",
        "cmfSignal": "POSITIVE|NEGATIVE",
        "cmf": <float>,
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "priceStructure": {
        "zone": "<S/R zone>",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      }
    },
    "trendEngine": {
      "trendDirection": {
        "priceVsSMA20": "ABOVE|BELOW",
        "priceVsSMA50": "ABOVE|BELOW",
        "priceVsSMA100": "ABOVE|BELOW",
        "priceVsSMA200": "ABOVE|BELOW",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      },
      "trendQuality": {
        "adx": <float>,
        "adxTrend": "RISING|FALLING",
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
        "expanding": true|false,
        "condition": "EXPANDING|CONTRACTING",
        "growthOutput": "<plain language, max 15 words>",
        "valueOutput": "<plain language, max 15 words>"
      }
    },
    "dominanceEngine": {
      "leadership": {
        "vsNifty": {
          "signal": "OUTPERFORMING|UNDERPERFORMING",
          "growthOutput": "<plain language, max 15 words>",
          "valueOutput": "<plain language, max 15 words>"
        },
        "vsSector": {
          "signal": "OUTPERFORMING|UNDERPERFORMING|null",
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
    "grade": "A+|A|B|C|D",
    "label": "<string>"
  }
}
```

---

## Step 13: Markdown Summary (for testing only)

```
## <TICKER> — <DATE>
Lens: <type> | <horizon>
Tag: <plain composite tag>
Conviction: <label> (<score>/100)

SCORES
[table: Module | Score | Max]

BUCKET TAGS
Structure:        [colour] <tag> | <output> | Watch: <watchout>
Trend:            [colour] <tag> | <output> | Watch: <watchout>
Timing:           [colour] <tag> | <output> | Watch: <watchout>
Relative Strength:[colour] <tag> | <output> | Watch: <watchout>

ACTIONABLE INSIGHT
New:   <text>
Hold:  <text>
Watch: <text>

LEVELS TO WATCH
Immediate:  Rs.<price>
Structural: Rs.<price>
Regime:     Rs.<price>
Note: <horizon note>

WHAT CAN CHANGE
- <bullet 1>
- <bullet 2>
- <bullet 3>
```

---

## Edge Cases
```
< 50 candles:        flag missing indicators, confidence = Low
SMA_200 missing:     treat as bearish regime, flag
Wyckoff ambiguity:   run resolution first, flag if relabelled
Playbook tie:        most conservative (Base > Pullback > Breakout)
No S/R provided:     S/R modifier = 0, flag in output
Horizon conflict:    output primary + note conflict
```
