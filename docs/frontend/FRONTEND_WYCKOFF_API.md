[Docs](../README.md) · [Frontend](../README.md#existing-reference-material) · Wyckoff API — Frontend Note

# Wyckoff API — Frontend Note

The Wyckoff engine now runs server-side. `src/lib/wyckoff.ts` is a **1:1 port** — verified
bit-exact against the TypeScript original on 248 symbols (phase, sub-phase, confidence, pivot
sequence, all six detections, ranges, metrics, and every narrative string match exactly).

Shapes below are copied from a **live response** for `RELIANCE`, not from the schema.

---

## 1. Endpoint

```bash
curl -s 'http://localhost:8000/api/screener/RELIANCE/wyckoff' | jq

# Analysis only, no OHLCV (much lighter)
curl -s 'http://localhost:8000/api/screener/RELIANCE/wyckoff?includeBars=false' | jq

# 1 year of chart bars, custom zigzag threshold
curl -s 'http://localhost:8000/api/screener/RELIANCE/wyckoff?chartYears=1&minPct=8' | jq
```

`:symbol` is upper-cased server-side.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `chartYears` | int (1–20) | `3` | Years of OHLCV in `chart.bars`. Analysis always uses the full series regardless. |
| `includeBars` | bool | `true` | `false` omits the whole `chart` block. |
| `minPct` | float | auto | Override the adaptive zigzag threshold. Omit to use the computed value. |

**Envelope is flat** — no `{ success, data }` wrapper. This matches `/technicals`, `/prices` and
`/peers`; the spec's `{ success, data }` assumption was wrong for this area.

**Errors**
- `404 { "error": "No price data found for symbol XYZ" }` — unknown symbol.
- Insufficient history is **not** an HTTP error. You get `200` with `meta.insufficientData: true`,
  `phase.subPhase: "Insufficient Data"`, `confidence: 0`, empty arrays and null ranges — render
  your empty state from that flag.

`Cache-Control` is set to expire at midnight IST, so the browser/CDN caches it for the day.

---

## 2. Read `meta` first — it qualifies everything else

```jsonc
"meta": {
  "insufficientData": false,
  "minBarsRequired": 20,
  "barInterval": "1d",
  "zigzagMinPct": 11.57,        // adaptive threshold actually used
  "engineVersion": "1.0.0",

  "analysisStart": "2025-05-31", // first bar actually analysed
  "historyTruncated": true,
  "droppedLeadingBars": 282,
  "droppedTrailingBars": 0,
  "totalRowsAvailable": 530,

  "returnsSaturated": { "r365": true, "r504": true, "r756": true },
  "suspectedSplit": false,
  "suspectedSplitEvents": []
}
```

Three things here are load-bearing — please don't ignore them:

**`historyTruncated` / `analysisStart`.** `nse_equity_new` is only true daily data from
~2025-06. Before that it holds daily bars *sampled once a week* (verified: pre-2025 bar spread
matches a single day, ~1.4%, not a real week's ~3.2%). Mixing the two breaks every volume/spread
gate, so the engine automatically selects the most recent contiguous daily run and analyses that.
Today that means **~248 bars covering ~1 year**, not the ~2,500 the spec assumed. Any UI copy
promising "10 years of structure" needs rewording. This widens by itself once daily history is
backfilled — no frontend change needed then.

**`returnsSaturated`.** When a lookback exceeds the available series the engine returns the
full-history change rather than null (inherited behaviour, deliberately preserved). With ~248 bars
`r365`, `r504` and `r756` all collapse to the same number. Don't render them as three distinct
horizons while these flags are true — show one, or label it "since {analysisStart}".

**`suspectedSplit`.** Prices are **not split-adjusted upstream**. A 10:1 split reads as a −90%
crash, which the engine scores as a deep Markdown with high confidence. ~5% of symbols have one
inside the current window. When `suspectedSplit` is true, surface a caution and treat the phase as
unreliable — `suspectedSplitEvents[]` gives `{ date, prevClose, close, changePct }`. The engine
deliberately does **not** back-adjust, because that would silently rewrite a genuine crash.

---

## 3. Core blocks

```jsonc
{
  "symbol": "RELIANCE", "ticker": "RELIANCE.NS",
  "currency": "INR",            // drive ₹ vs $ off this, don't hardcode
  "asOf": "2026-06-01",         // last analysed bar — NOT necessarily today
  "barCount": 248,

  "phase": {
    "type": "Re-Distribution",  // Accumulation|Markup|Re-Accumulation|Distribution|Markdown|Re-Distribution
    "subPhase": "Phase C",      // ""|Phase A..D|Spring|SOS Pullback|SOS Breakout|UTAD|LPSY|Insufficient Data
    "confidence": 62,           // 0..95 integer
    "cycleIndex": 5,            // index into cycle.phases, for the schematic
    "score": 0,                 // raw classifier score; safe to hide
    "description": "Price is pausing in a ₹1310–₹1380 (5.1% wide, 30 bars) range mid-downtrend…"
  },

  "signal": {
    "emoji": "⏸️",
    "title": "RE-DISTRIBUTION — Next Leg Down Loading",
    "body": "Short rallies to range resistance ₹1380 — Upthrust confirmed…",
    "direction": "bearish"      // bullish|bearish|neutral — colour off this, never string-match the title
  },

  "cycle": {
    "phases": ["Accumulation","Markup","Re-Accumulation","Distribution","Markdown","Re-Distribution"],
    "activeIndex": 5
  }
}
```

`metrics` is flat and all-numeric (2-dp rounded):

```jsonc
"metrics": {
  "lastClose": 1320, "priceChangePct": -7.1,
  "structure": "downtrend",     // uptrend|downtrend|insufficient
  "priorStructure": "down",     // up|down
  "priorPctChg": -1.21, "pivotCount": 7,
  "volumeBias": "bullish",      // bullish|bearish|neutral
  "volumeDrying": false, "volumeRatio": 1.23, "sma20": 1374.13,
  "allTimeHigh": 1611.8, "allTimeLow": 1290,
  "pricePosition": 0.09,        // 0..1 within all-time range
  "posIn2yrRange": 0.09, "nearSwingHigh2yr": false, "nearSwingLow2yr": true,
  "correctionInUptrend": false,
  "returns": { "r126": -1.21, "r365": -3.93, "r504": -3.93, "r756": -3.93, "rMacro": -3.93 },
  "pctFromATH": -18.1
}
```

### Ranges — all three may be `null`

`tradingRange` (active range), `priorRange` (was `ptr`), `localBreakout` (SOS micro-breakout).
Guard every one. Only one is typically populated: the engine looks for an active range first,
falls back to a prior range, then to a local breakout.

```jsonc
"tradingRange": {
  "top": 1380, "bottom": 1310, "mid": 1340, "widthPct": 5.1,
  "startBarIdx": 218, "barCount": 30,
  "positionInRange": 0.14,       // computed server-side now
  "density": 0.27, "totalMembers": 8, "lookback": 30,
  "resistanceCount": 5, "supportCount": 3,
  "levels": [                    // was tr.allRanges — draw these as nested bands
    { "label": "Micro", "lookback": 30,  "top": 1380, "bottom": 1310, "mid": 1340,
      "widthPct": 5.1,  "density": 0.27, "members": 8,  "isPrimary": true },
    { "label": "Inner", "lookback": 120, "top": 1450, "bottom": 1300, "mid": 1380,
      "widthPct": 10.4, "density": 0.14, "members": 17, "isPrimary": false }
  ]
}
```

`localBreakout` adds `breakoutDate`, `breakoutClose`, `breakoutVolume`, `rangeAvgVolume`,
`volumeRatio`, `priorRallyPct`. `priorRange` adds `brokeUp`, `brokeDown`, `peakAfter`,
`troughAfter`, `returnPct`, `positionInRange`.

> Heads-up: `localBreakout` is currently **always null** in practice. One of its gates is
> "breakout bar within the last 10 bars", and the price feed is stale (see §5) — so nothing
> qualifies. The detector is correct (verified against a synthetic control); it'll start firing
> once the feed is current.

### `detections` — structured, never parse prose

```jsonc
"detections": {
  "ps":  { "detected": false },
  "sc":  { "detected": false },
  "st":  { "detected": false },
  "psy": { "detected": false },
  "bc":  { "detected": false },
  "sow": { "detected": true, "date": "2026-04-06", "barIdx": 210, "price": 1304.7 },
  "spring":   { "detected": false },
  "upthrust": { "detected": true }
}
```

When `detected` is false the object has **only** that key. `sc` additionally carries `arHigh`,
`bc` carries `arLow`. `spring`/`upthrust` are states, not bars — they only ever have `detected`.

### `events[]` — the checklist, ordered and ready to render

```jsonc
{ "tag": "RANGE", "label": "Trading Range", "ok": true,
  "text": "₹1310–₹1380 (5.1% wide, 30 bars) | Price at 14% of range",
  "values": { "bottom": 1310, "top": 1380, "widthPct": 5.1, "barCount": 30, "positionPct": 14 } }
```

Render `text` as-is, or build your own copy from `values`. The set of tags varies by phase family
(accumulation shows PS/SC/ST/SPRING/SOS/VOL, distribution shows PSY/BC/SOW/UT/LPSY/VOL), so key
off `tag` and don't assume a fixed length. `values` is `{}` for undetected events.

### `pivots[]` — zigzag, chronological, strictly alternating high/low

```jsonc
{ "type": "low", "index": 64, "date": "2025-09-01", "price": 1340.6,
  "structureLabel": "LL",   // HH|LH|EH|HL|LL|EL — ±1.5% dead zone yields EH/EL. null on the first of its type.
  "swingPct": -13.6,        // % change from the previous pivot. null on the first pivot.
  "eventBadge": null }      // SC|BC|SPR|UT|null
```

All three derived fields are precomputed — the canvas draw loop no longer needs to derive
anything. `index` indexes into `chart.bars` **only when `chartYears` covers the whole series**;
otherwise treat indices as relative to the analysed series, not the chart slice.

### `chart` — omitted entirely when `includeBars=false`

```jsonc
"chart": {
  "years": 3,
  "bars": [ { "date": "2025-05-31", "open": 1420, "high": 1432, "low": 1411, "close": 1425, "volume": 8213400 } ],
  "sma20": [ null, null, "…", 1374.13 ]   // aligned 1:1 with bars, leading nulls during warmup
}
```

---

## 4. Migration checklist

| Change | Action |
|---|---|
| `usePrices` + `analyzeWyckoff` | Replace with a single `useWyckoff(symbol)` hook |
| `src/lib/wyckoff.ts` | Delete. Keep only `phaseTokens` / presentation constants; `CYCLE_DESC` can stay frontend-side or move into `cycle` later |
| `MessageChannel` deferral + `analyzing` state | Delete — no client-side compute left |
| Canvas draw loop derivations | Delete — use `pivots[].structureLabel` / `.swingPct` / `.eventBadge` and `chart.sma20` |
| Hardcoded `₹` | Render from `currency` |
| `width` as a string (`"7.3"`) | Now `widthPct` as a **number**, everywhere (TR, levels, priorRange, localBreakout) |
| `failedBreakout`, `expandedRange`, `.expanded`, `priorWasUp`, `priorWasDown` | **Gone.** They were hardcoded false or redundant with `priorStructure` |
| `tr.allRanges` | Renamed `tradingRange.levels`; `lb` → `lookback`, `width` → `widthPct` |
| `ptr` | Renamed `priorRange`; `posInRange` → `positionInRange` |
| Signal colour by string-matching the title | Use `signal.direction` |
| "ATR-based dynamic threshold" label | Inaccurate — it's percentile-of-swings. Relabel. |
| "Need at least 10 bars" copy | Guard is and always was 20; the message now says 20 |

---

## 5. Known caveats

- **The price feed is stale.** Last real session in `nse_equity_new` is ~2026-05-29, with two
  isolated stragglers after it. `asOf` reports the last *analysed* bar honestly — don't assume it
  is today, and don't render it as a live quote. Being chased separately.
- **~1 year of history, not 10.** See `meta.historyTruncated`. Everything still computes; the
  long-horizon returns just saturate.
- **Prices are not split-adjusted.** See `meta.suspectedSplit`. ~5% of symbols affected.
- **`localBreakout` never fires today.** Consequence of the stale feed, not a bug.
- **`zigzagMinPct` clusters at its 15% ceiling** for ~75% of symbols. That's inherited from the
  original algorithm (it takes the largest swing that still leaves ≥6 pivots, then clamps to
  [3,15]) and is unchanged by the port — flagging it because it means the "adaptive" threshold is
  effectively constant for most names. Worth revisiting together once history is backfilled.
- **`phase.score` is only meaningful when `tradingRange` is non-null**; it's `0` otherwise.
