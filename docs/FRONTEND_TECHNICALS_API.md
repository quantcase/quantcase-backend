# Technicals API — Frontend Note

Covers the `technical-intelligence` skill rewrite. All shapes below are copied from a
**live verified response** for `HDFCBANK` (BullMQ job 1401), not from the schema.

---

## 1. Endpoint

```bash
# Cached read (serves the stored AI insight; enqueues a job if none exists yet)
curl -s 'http://localhost:8000/api/screener/HDFCBANK/technicals' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' | jq

# Force refresh — skips the cache, returns decisionIntelligence: null,
# and enqueues a regeneration job in the background
curl -s 'http://localhost:8000/api/screener/HDFCBANK/technicals?refresh=1' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' | jq
```

`:symbol` is upper-cased server-side. `404` if the ticker isn't in the watchlist sheet.

### Behaviour to handle in the UI

| Case | `decisionIntelligence` | What to render |
|---|---|---|
| Insight exists | populated object | Full view |
| First-ever call, or `?refresh=1` | **`null`** | Raw TA (charts, levels, ruleEngine) + "AI analysis generating…" placeholder; poll again in ~60–90s |

`?refresh=1` is **not** synchronous — it always returns `null` for the AI block on that
call. Don't await it expecting fresh narrative.

---

## 2. Response envelope

```jsonc
{
  "symbol": "HDFCBANK",
  "exchange": "NSE",
  "timestamp": "...",
  "meta": { "macroSector": "Financial Services", "basicIndustry": "Private Sector Bank",
            "pe": "16.66", "sheetTrend": "SIDEWAYS", "srRange": "18.27%",
            "nextEarningsDate": null },

  "stockType":      { "stats": { ... }, "validSMA200Cross": null },   // NEW
  "smaDistancePct": { "sma20": 6.28, "sma50": 4.93,
                      "sma100": -3.45, "sma200": -16.13 },            // NEW

  "price": {...}, "trend": {...}, "movingAverages": {...}, "momentum": {...},
  "volume": {...}, "volatility": {...}, "supportResistance": {...},
  "patterns": {...}, "signals": {...}, "timeframes": {...}, "insights": {...},
  "ruleEngine": {...},

  "decisionIntelligence": { ... }   // the whole stored AI insight — see §3
}
```

> **Naming gotcha (unchanged, but easy to trip on):** the controller assigns the entire
> stored insight to `result.decisionIntelligence`, and that insight *itself* contains a
> `decisionIntelligence` key. So the narrative fields live at
> **`response.decisionIntelligence.decisionIntelligence.*`**.

---

## 3. `decisionIntelligence` (the stored insight)

Four top-level keys:

```jsonc
{
  "decisionIntelligence": { ... },   // narrative / tags / insights  — §3.1
  "scores":               { ... },   // 7-module scoring            — §3.2
  "stockClassification":  { ... },   // NEW — Growth/Value/Mixed     — §3.3
  "ruleEngine":           { ... }    // echo of the TA rule engine   — §3.4
}
```

### 3.1 `.decisionIntelligence` — narrative

```jsonc
{
  "tag": "Deteriorating, Stay On Sidelines",
  "lens": "Mixed",                       // Growth | Value | Mixed
  "idealFor": "Not Suitable",            // Swing | Positional | Investor | Not Suitable
  "timeframe": "-",
  "playbook": "No Setup",
  "convictionLevel": "Low",
  "convictionScore": 43,

  // NEW
  "previousScore": 38,                   // null on a ticker's first run
  "directionFlag": "Band Falling",       // Tier/Band Rising|Falling, Flat, or null
  "breakoutQuality": null,               // "High Conviction" or null

  "currentRegime": {
    "label": "Consolidation, Low Conviction",
    "description": "Base formation in progress but lacking conviction..."
  },

  // NEW — transparency into the Ideal For vote
  "idealForScores": { "swing": 1, "positional": 2, "investor": 2 },

  "indicators": [ /* exactly 8 — see below */ ],

  "levelsToWatch": {
    "immediate":   { "price": 779.56, "label": "Short term support" },
    "structural":  { "price": 700,    "label": "Key support" },
    "regime":      { "price": 975.22, "label": "Long term average" },
    "horizonNote": "Break below Rs.700 support = structural change; ..."
  },

  "whatCanChange": [ "…", "…", "…" ],    // 2–3 short bullets
  "priorityWatchout": "Underperforming market and sector on all fronts...",

  "actionableInsight":            { /* swing      */ },
  "actionableInsight_positional": { /* positional */ },
  "actionableInsight_investor":   { /* investor   */ },

  "ruleEngine": { "tabSummaries": {
      "structure": "…", "trend": "…", "timing": "…", "relativeStrength": "…" } }
}
```

**`indicators[]` — always exactly 8, one per bucket:**

```jsonc
{
  "id": "trend_quality",                 // NEW — stable key, safe to switch on
  "name": "Trend Quality",               // derived server-side from id
  "tab": "Trend",                        // derived server-side from id
  "tag": "Trend Losing Energy Gradually",
  "sentiment": "negative",               // positive | negative | transitional
  "explanation": "Trend strength declining. ADX falling within 15-25 zone...",
  "growthWatchout": "…",
  "valueWatchout": "…"
}
```

`id` → `tab` mapping (fixed, `utils/technicalsShape.js`):

| `id` | `tab` |
|---|---|
| `market_structure`, `capital_participation`, `price_architecture` | Structure |
| `trend_direction`, `trend_quality` | Trend |
| `momentum`, `volatility` | Timing |
| `relative_strength` | Relative Strength |

Group by `tab` for the tab strip; use `sentiment` for the chip colour
(`positive` → green, `negative` → red, `transitional` → amber).

**Each `actionableInsight*`:**

```jsonc
{
  "new_position":      "Avoid. Weak participation and money flowing out. No entry yet.",
  "existing_position": "Reduce. Trail above Rs.779 short term support. Exit below Rs.750.",
  "watch_for":         "Strong volume break above Rs.850 or close below Rs.779..."
}
```

Pick the variant matching the user's selected horizon; `.actionableInsight` is swing.
Any of the three may be `null` if the model skipped that horizon — guard before rendering.

### 3.2 `.scores`

```jsonc
{
  "final_score": 43, "grade": "C", "label": "Weak",
  "structure_wyckoff_sr": 9,   // /20
  "trend_sma": 5,              // /20
  "momentum_rsi": 8,           // /15
  "trend_maturity_adx": 6,     // /15
  "leadership_rs": 0,          // /15
  "capital_flow": 1,           // /10
  "volatility_bbw": 2          // /5
}
```

Pair `final_score` with `decisionIntelligence.previousScore` + `directionFlag` for a
delta badge. Both are `null` on a ticker's first-ever run — render no badge, not "0".

### 3.3 `.stockClassification` — NEW

```jsonc
{
  "stock_type": "Mixed",          // Growth | Value | Mixed
  "growth_score": 1,
  "value_score": 2,
  "classification_note": "Stock shows mixed characteristics - no dominant type identified",
  "wyckoff_growth_warning": null  // string when a Growth call conflicts with the Wyckoff phase
}
```

`stock_type` drives which watchout the UI surfaces: `Growth` → `growthWatchout`,
`Value` → `valueWatchout`, `Mixed` → show both or neither (product call).
Surface `wyckoff_growth_warning` as a caution banner when non-null.

### 3.4 `.ruleEngine`

Unchanged shape (`structureEngine`, `trendEngine`, `timingEngine`, `dominanceEngine`,
`decisionContext`) with one addition:

```jsonc
"dominanceEngine": { "leadership": {
  "vsNifty":       { "signal": "UNDERPERFORMING", "crsValue": 99.97, "prevCrsValue": 100.53, ... },
  "vsSector":      { "signal": "UNDERPERFORMING", "crsValue": 99.05, "sectorTicker": "NIFTY FINANCIAL SERVICE", ... },
  "vsSectorNifty": { "signal": "OUTPERFORMING",   "crsValue": 100.94, "prevCrsValue": 100.76,
                     "sectorTicker": "NIFTY FINANCIAL SERVICE" }   // NEW — sector vs NIFTY
}}
```

`vsSectorNifty` answers "is the sector itself leading the market?" — a three-leg RS read
(stock vs market, stock vs sector, sector vs market). It has **no** `growthOutput` /
`valueOutput` / watchout strings; render `signal` + `crsValue` only.

Note: on the **top-level** `ruleEngine` the controller strips `growthWatchout` /
`valueWatchout` from the eight buckets. The copy nested under `decisionIntelligence`
keeps them.

### 3.5 `stockType.stats` — NEW (raw inputs, top level)

```jsonc
{ "adx100Avg": 31.17, "rsiAbove55Pct": 2, "rsiBelow50Pct": 89,
  "sma200TouchCount": 0, "sma200TouchWindow": 147,
  "sma50UpPct": 0, "sma50DownPct": 100,
  "sma200DistancePct": -16.13, "barsAvailable": 346 }
```

Inputs to the Growth/Value classification — useful for a debug/"why this call?" panel.
`null` when fewer than 200 bars are available. Sibling `validSMA200Cross` is `null`
unless a valid cross was detected in the last 30 bars.

---

## 4. Migration checklist

| Change | Action |
|---|---|
| `indicators[].id` added | Switch on `id`, not `name` — names are now derived and could be reworded |
| `stockClassification` added | New block; pick which watchout to show |
| `previousScore` / `directionFlag` added | Delta badge; **both null on first run** |
| `idealForScores` added | Optional transparency panel |
| `breakoutQuality` added | Nearly always `null` today — only set on a confirmed volume breakout |
| `vsSectorNifty` added | Third RS leg; no output/watchout strings |
| `stockType` / `smaDistancePct` added at top level | Optional debug panel |
| `levelsToWatch.horizonNote` added | Footnote under the levels list |

Nothing was removed or renamed — the change is **additive**, so existing screens keep
working without edits.

---

## 5. Known caveats

- **`directionFlag` may be inverted.** On the verified HDFCBANK run the score rose
  38 → 43 but the flag read `"Band Falling"`. Prefer computing the arrow from
  `final_score - previousScore` and treat `directionFlag` as advisory until this is fixed.
- **`stock_type` skews `Mixed`.** Only one ticker verified so far; the pre-fix baseline
  had it `Mixed` for 1478/1478 rows. Don't build UI that assumes a good Growth/Value split
  until a wider sample confirms it.
- **Sector selection now keys off `BASIC INDUSTRY`** (via `utils/sectorIndexMap.js`), so a
  private bank compares to NIFTY Private Bank, a chemical to NIFTY Chemicals, a cement to
  NIFTY Cement, etc. — not the coarse macro-sector bucket. `sectorTicker` reflects the
  resolved index.
- **CRS `vsSector` / `vsSectorNifty` values are `null` until index history is backfilled.**
  All index legs are now read from `nse_equity_new`, where each NIFTY index currently holds
  only a single snapshot row (no time series yet). The correct `sectorTicker` still shows;
  the strength value fills in once daily index history is ingested. Basic industries with no
  dedicated NIFTY index (telecom, diversified) resolve to `null` (no sector leg).
