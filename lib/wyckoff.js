'use strict';

/**
 * Wyckoff Phase Analysis Engine.
 *
 * A 1:1 port of the frontend's `src/lib/wyckoff.ts`, which itself came from
 * `docs/wyckoff-analyzer.html`. The engine is pure and side-effect-free — no Prisma,
 * no I/O, no module state. Feed it bars, get a result.
 *
 * Where the frontend source and `api-wyckoff.md` disagree, the source wins: it is what
 * the page renders today, and the point of moving this server-side is to stop the two
 * from drifting, not to introduce a third behaviour.
 *
 * Deliberate deviations from the source, all from api-wyckoff.md §5:
 *   - `width` is a number (`widthPct`) everywhere, never a string.
 *   - `failedBreakout` / `expandedRange` / `.expanded` / `priorWasUp` / `priorWasDown`
 *     are dropped — they were hardcoded false or redundant with `priorStructure`.
 *   - `phaseColor()` stays frontend-side; it's presentation, not analysis.
 *   - The dead `avgVol`/`avgSpread` locals in `detectST` are gone.
 *   - The insufficient-data message says 20 bars, matching the guard (it said 10).
 *   - The `_dynMinPctCache` memo is dropped; HTTP caching covers it and this module
 *     stays pure.
 */

const MIN_BARS = 20;
const ENGINE_VERSION = '1.1.0';

// How far outside a trading range the last close may sit before the range is abandoned,
// as a fraction of range width. Breaches inside this band keep the range and are reported
// as such — see the containment check in try3CandleWindow.
const RANGE_BREACH_TOL = 0.35;

const WYCKOFF_CYCLE = [
  'Accumulation', 'Markup', 'Re-Accumulation',
  'Distribution', 'Markdown', 'Re-Distribution',
];

// ── Daily-era selection ───────────────────────────────────────────────────────

/**
 * nse_equity_new is not uniformly daily. Before ~2025-06 it holds daily bars sampled
 * once a week (verified: pre-2025 spread matches a single day, not a week), and the
 * newest rows can be isolated stragglers after a stale feed. Running detectors that
 * compare a bar against a 60-bar prior window across that seam produces nonsense — a
 * weekly-sampled stretch looks like a volume collapse next to a real daily one.
 *
 * So: cut the series into runs of consecutive bars no more than `maxGapDays` apart
 * (4 covers Fri→Mon plus a holiday), and keep the most recent run that is long enough
 * to analyse. Nothing here is hardcoded to a date — once daily history is backfilled
 * the whole series becomes one run and this returns it untouched.
 *
 * @param {Array<{date: string}>} bars ascending by date
 * @returns {{ bars: Array, droppedLeading: number, droppedTrailing: number, truncated: boolean }}
 */
function selectContiguousDailyEra(bars, { maxGapDays = 4, minBars = MIN_BARS } = {}) {
  const empty = { bars: [], droppedLeading: 0, droppedTrailing: 0, truncated: false };
  if (!Array.isArray(bars) || bars.length === 0) return empty;

  const runs = [];
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    const gap = (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 86400000;
    if (gap > maxGapDays) {
      runs.push([start, i - 1]);
      start = i;
    }
  }
  runs.push([start, bars.length - 1]);

  // Most recent run with enough bars to analyse. Falls back to the longest run so a
  // symbol with only sparse history still gets the insufficient-data shape rather than
  // an empty one.
  let chosen = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i][1] - runs[i][0] + 1 >= minBars) { chosen = runs[i]; break; }
  }
  if (!chosen) {
    chosen = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a), runs[0]);
  }

  const [lo, hi] = chosen;
  return {
    bars: bars.slice(lo, hi + 1),
    droppedLeading: lo,
    droppedTrailing: bars.length - 1 - hi,
    truncated: lo > 0 || hi < bars.length - 1,
  };
}

/**
 * Flag likely corporate actions (splits, bonuses) in an otherwise-continuous series.
 *
 * nse_equity_new stores raw prices with no split adjustment, so a 10:1 split reads as a
 * -90% single-day crash. The engine cannot tell that from a real collapse: it pins
 * pricePos near 0, computes pctFromATH near -90, and returns "Markdown" with high
 * confidence. That is confidently wrong, which is worse than uncertain.
 *
 * This does NOT adjust prices — on its own, a price gap cannot be told apart from a
 * genuine crash. It only reports what it saw. `backAdjustSplits()` below is the piece
 * that decides, using market-cap continuity as the discriminator.
 *
 * @returns {{ suspected: boolean, events: Array<{date, prevClose, close, changePct}> }}
 */
function detectSuspectedSplits(bars, { dropPct = -25, risePct = 60 } = {}) {
  const events = [];
  for (let i = 1; i < bars.length; i++) {
    const chg = (bars[i].close - bars[i - 1].close) / bars[i - 1].close * 100;
    if (chg <= dropPct || chg >= risePct) {
      events.push({
        date: bars[i].date,
        prevClose: bars[i - 1].close,
        close: bars[i].close,
        changePct: Math.round(chg * 10) / 10,
      });
    }
  }
  return { suspected: events.length > 0, events };
}

// Corporate actions land on exact ratios; a price gap that lands within a few percent of
// one is almost certainly a split/bonus rather than a coincidence.
const CLEAN_SPLIT_FACTORS = [
  1 / 2, 1 / 3, 2 / 3, 1 / 4, 3 / 4, 1 / 5, 2 / 5, 3 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100,
  3 / 2, 2, 5 / 2, 3, 4, 5, 10,
];

const _r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);

/**
 * Back-adjust prices across corporate actions, but only where they can be corroborated.
 *
 * A bare price gap is ambiguous — a 1:1 bonus and a -50% collapse look identical in an
 * OHLC series, which is why `detectSuspectedSplits` refuses to touch prices. Market cap
 * breaks the tie: on a split or bonus the share count absorbs the move and market cap is
 * continuous, whereas a genuine crash destroys market cap along with the price. So we
 * adjust only when market cap held across the gap, and leave everything else alone.
 *
 * The factor is `priceRatio / marketCapRatio`, which divides out the genuine same-day
 * move and leaves the corporate action by itself. Volume is scaled the other way, since
 * the share count changed with the price.
 *
 * Requires `bar.marketCap` (see fetchWyckoffBars). Without it nothing is adjusted and the
 * events are returned flagged but untouched, which is the old behaviour.
 *
 * @returns {{ bars: Array, events: Array, adjusted: boolean }}
 */
function backAdjustSplits(bars, opts = {}) {
  const { mcapTolerance = 0.15, snapTolerance = 0.03 } = opts;
  const { suspected, events } = detectSuspectedSplits(bars, opts);
  if (!suspected) return { bars, events: [], adjusted: false };

  const idxByDate = new Map(bars.map((b, i) => [b.date, i]));
  const classified = events.map((ev) => {
    const i = idxByDate.get(ev.date);
    const prev = bars[i - 1], curr = bars[i];
    const priceRatio = curr.close / prev.close;
    const out = { ...ev, priceRatio: _r4(priceRatio) };

    if (!(prev.marketCap > 0) || !(curr.marketCap > 0)) {
      return { ...out, corporateAction: false, reason: 'no market-cap data to corroborate' };
    }
    const mcapRatio = curr.marketCap / prev.marketCap;
    out.marketCapRatio = _r4(mcapRatio);
    if (Math.abs(mcapRatio - 1) > mcapTolerance) {
      return {
        ...out,
        corporateAction: false,
        reason: `market cap moved ${((mcapRatio - 1) * 100).toFixed(1)}% — reads as a genuine price move`,
      };
    }

    let factor = priceRatio / mcapRatio;
    const snapped = CLEAN_SPLIT_FACTORS.find(f => Math.abs(factor - f) / f <= snapTolerance);
    if (snapped != null) factor = snapped;
    return {
      ...out,
      corporateAction: true,
      factor: _r4(factor),
      snappedToCleanRatio: snapped != null,
      reason: 'market cap continuous across the gap — share count absorbed the move',
    };
  });

  const actions = classified.filter(e => e.corporateAction);
  if (!actions.length) return { bars, events: classified, adjusted: false };

  // Each action rescales everything before it; applying them in turn compounds correctly
  // when a series carries more than one.
  const out = bars.map(b => ({ ...b }));
  for (const ev of actions) {
    const i = idxByDate.get(ev.date);
    for (let j = 0; j < i; j++) {
      out[j].open  *= ev.factor;
      out[j].high  *= ev.factor;
      out[j].low   *= ev.factor;
      out[j].close *= ev.factor;
      if (out[j].volume) out[j].volume = Math.round(out[j].volume / ev.factor);
    }
  }
  return { bars: out, events: classified, adjusted: true };
}

// ── Zigzag pivot engine ───────────────────────────────────────────────────────

function detectPivots(bars, k = 3) {
  const pivots = [];
  const n = bars.length;
  for (let i = k; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (bars[i].high <= bars[i - j].high || bars[i].high <= bars[i + j].high) isH = false;
      if (bars[i].low >= bars[i - j].low || bars[i].low >= bars[i + j].low) isL = false;
    }
    if (isH) pivots.push({ type: 'high', index: i, price: bars[i].high, date: bars[i].date, bar: bars[i] });
    if (isL) pivots.push({ type: 'low', index: i, price: bars[i].low, date: bars[i].date, bar: bars[i] });
  }
  return pivots.sort((a, b) => a.index - b.index);
}

function alternateFilter(pivots) {
  if (!pivots.length) return [];
  const zz = [pivots[0]];
  for (let i = 1; i < pivots.length; i++) {
    const last = zz[zz.length - 1], curr = pivots[i];
    if (curr.index === last.index) {
      if (curr.type === last.type) {
        if (curr.type === 'high' && curr.price > last.price) zz[zz.length - 1] = curr;
        else if (curr.type === 'low' && curr.price < last.price) zz[zz.length - 1] = curr;
      }
      continue;
    }
    if (curr.type === last.type) {
      if (curr.type === 'high' && curr.price > last.price) zz[zz.length - 1] = curr;
      else if (curr.type === 'low' && curr.price < last.price) zz[zz.length - 1] = curr;
    } else {
      zz.push(curr);
    }
  }
  return zz;
}

function significanceFilter(zz, minPct = 2.0) {
  if (zz.length < 2) return zz;
  let changed = true;
  let arr = zz.slice();
  while (changed) {
    changed = false;
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      const last = out[out.length - 1];
      const curr = arr[i];
      const pct = Math.abs(curr.price - last.price) / last.price * 100;
      if (pct >= minPct) {
        out.push(curr);
      } else {
        if (curr.type === last.type) {
          if (curr.type === 'high' && curr.price > last.price) out[out.length - 1] = curr;
          else if (curr.type === 'low' && curr.price < last.price) out[out.length - 1] = curr;
        } else if (out.length >= 2) {
          const prev = out[out.length - 2];
          const keepLast = Math.abs(last.price - prev.price) >= Math.abs(curr.price - prev.price);
          if (!keepLast) out[out.length - 1] = curr;
        } else {
          if (curr.type === 'high' && curr.price > last.price) out[out.length - 1] = curr;
          else if (curr.type === 'low' && curr.price < last.price) out[out.length - 1] = curr;
        }
        changed = true;
      }
    }
    arr = out;
  }
  return alternateFilter(arr);
}

/**
 * Adaptive zigzag threshold: percentile-of-swings, NOT ATR-based despite the label the
 * frontend currently shows (api-wyckoff.md §4.2 flags the relabel).
 *
 * Walk swing magnitudes from largest down, take the largest candidate >= 3% that still
 * leaves at least 6 pivots. Clamped to [3, 15].
 */
function dynamicMinPct(bars) {
  if (bars.length < MIN_BARS) return 3.0;
  const rawAlt = alternateFilter(detectPivots(bars, 3));
  if (rawAlt.length < 4) return 3.0;
  const swings = rawAlt.slice(1)
    .map((p, i) => Math.abs(p.price - rawAlt[i].price) / rawAlt[i].price * 100)
    .sort((a, b) => a - b);
  const TARGET = 6;
  let chosen = 3.0;
  for (let i = swings.length - 1; i >= 0; i--) {
    const cand = swings[i];
    if (cand < 3.0) break;
    if (significanceFilter(rawAlt.slice(), cand).length >= TARGET) { chosen = cand; break; }
  }
  return Math.min(15, Math.max(3, chosen));
}

function getZigzag(bars, k = 3, minPct = null) {
  const threshold = minPct !== null ? minPct : dynamicMinPct(bars);
  return significanceFilter(alternateFilter(detectPivots(bars, k)), threshold);
}

// ── Volume helpers ────────────────────────────────────────────────────────────

function swingVolume(bars, zz) {
  if (zz.length < 2) return { upSwingVol: 0, dnSwingVol: 0, volBias: 'neutral' };
  const last4 = zz.slice(-4);
  let upIntensity = 0, dnIntensity = 0, upSwings = 0, dnSwings = 0;
  for (let i = 1; i < last4.length; i++) {
    const a = last4[i - 1], b = last4[i];
    const swingBars = bars.slice(a.index, b.index + 1);
    const swingLen = Math.max(1, swingBars.length);
    const intensity = swingBars.reduce((s, x) => s + x.volume, 0) / swingLen;
    if (b.type === 'high') { upIntensity += intensity; upSwings++; }
    else { dnIntensity += intensity; dnSwings++; }
  }
  const avgUp = upSwings ? upIntensity / upSwings : 0;
  const avgDn = dnSwings ? dnIntensity / dnSwings : 0;
  const volBias = avgUp > avgDn * 1.2 ? 'bullish' : avgDn > avgUp * 1.2 ? 'bearish' : 'neutral';
  return { upSwingVol: avgUp, dnSwingVol: avgDn, volBias };
}

function isVolDrying(bars) {
  const fullAvg = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  const rec = bars.slice(-20);
  const recAvg = rec.reduce((s, b) => s + b.volume, 0) / rec.length;
  return recAvg < fullAvg * 0.72;
}

// ── Event detectors ───────────────────────────────────────────────────────────

function _avg(arr, pick) { return arr.reduce((s, x) => s + pick(x), 0) / arr.length; }
function _closePos(b) {
  const spread = b.high - b.low;
  return spread > 0 ? (b.close - b.low) / spread : 0.5;
}

function detectPS(bars) {
  const n = bars.length;
  for (let i = Math.max(5, n - 180); i < n - 2; i++) {
    const b = bars[i];
    const prior = bars.slice(Math.max(0, i - 60), i);
    if (prior.length < 5) continue;
    const avgVol = _avg(prior, x => x.volume);
    const avgSpread = _avg(prior, x => x.high - x.low);
    const priorLow = Math.min(...prior.map(x => x.low));
    const spread = b.high - b.low;
    if (b.close >= b.open) continue;
    if (spread <= avgSpread * 1.3) continue;
    if (b.volume <= avgVol * 1.3) continue;
    if (b.low > priorLow * 1.02) continue;
    if (_closePos(b) < 0.45) continue;
    // Exclude climactic bars so PS never collides with SC.
    if (spread > avgSpread * 1.8 && b.volume > avgVol * 2.0) continue;
    return { detected: true, idx: i, bar: b };
  }
  return { detected: false };
}

function detectPSY(bars) {
  const n = bars.length;
  for (let i = Math.max(5, n - 180); i < n - 2; i++) {
    const b = bars[i];
    const prior = bars.slice(Math.max(0, i - 60), i);
    if (prior.length < 5) continue;
    const avgVol = _avg(prior, x => x.volume);
    const avgSpread = _avg(prior, x => x.high - x.low);
    const priorHigh = Math.max(...prior.map(x => x.high));
    const spread = b.high - b.low;
    if (b.close <= b.open) continue;
    if (spread <= avgSpread * 1.3) continue;
    if (b.volume <= avgVol * 1.3) continue;
    if (b.high < priorHigh * 0.99) continue;
    if (_closePos(b) > 0.55) continue;
    if (spread > avgSpread * 1.8 && b.volume > avgVol * 2.0) continue;
    return { detected: true, idx: i, bar: b };
  }
  return { detected: false };
}

function detectST(bars, scResult) {
  if (!scResult.detected || scResult.idx == null || !scResult.bar) return { detected: false };
  const n = bars.length;
  const scIdx = scResult.idx;
  const scBar = scResult.bar;
  for (let i = scIdx + 3; i < Math.min(scIdx + 80, n); i++) {
    const b = bars[i];
    if (bars.slice(Math.max(0, i - 20), i).length < 3) continue;
    if (b.low > scBar.low * 1.08) continue;
    if (b.volume >= scBar.volume * 0.8) continue;
    if (b.high - b.low >= (scBar.high - scBar.low) * 0.8) continue;
    return { detected: true, idx: i, bar: b };
  }
  return { detected: false };
}

function detectSOW(bars, trBottom, trTop) {
  const n = bars.length;
  const trRange = trTop - trBottom;
  for (let i = Math.max(5, n - 120); i < n; i++) {
    const b = bars[i];
    const prior = bars.slice(Math.max(0, i - 30), i);
    if (prior.length < 5) continue;
    const avgVol = _avg(prior, x => x.volume);
    const avgSpread = _avg(prior, x => x.high - x.low);
    const spread = b.high - b.low;
    if (b.close >= b.open) continue;
    if (spread <= avgSpread * 1.3) continue;
    if (b.volume <= avgVol * 1.4) continue;
    if ((b.close - trBottom) / trRange > 0.30) continue;
    if (_closePos(b) > 0.35) continue;
    return { detected: true, idx: i, bar: b };
  }
  return { detected: false };
}

function detectSC(bars) {
  const n = bars.length;
  for (let i = 5; i < n - 3; i++) {
    const b = bars[i];
    const prior = bars.slice(Math.max(0, i - 60), i);
    if (prior.length < 5) continue;
    const avgVol = _avg(prior, x => x.volume);
    const avgSpread = _avg(prior, x => x.high - x.low);
    const priorLow = Math.min(...prior.map(x => x.low));
    const spread = b.high - b.low;
    if (b.close >= b.open) continue;
    if (spread <= avgSpread * 1.8) continue;
    if (b.volume <= avgVol * 2.0) continue;
    if (b.low > priorLow * 1.015) continue;
    if (_closePos(b) < 0.4) continue;
    // Forward-confirm: the climax only counts if price actually rallied off it.
    const lookAhead = Math.min(10, n - 1 - i);
    const nextBars = Array.from({ length: lookAhead }, (_, j) => bars[i + 1 + j]);
    const maxClose = Math.max(...nextBars.map(x => x.close));
    if (!nextBars.some(x => x.close > b.close)) continue;
    if (!(maxClose > b.close * 1.02)) continue;
    return { detected: true, idx: i, bar: b, arHigh: maxClose };
  }
  return { detected: false };
}

function detectBC(bars) {
  const n = bars.length;
  for (let i = 5; i < n - 3; i++) {
    const b = bars[i];
    const prior = bars.slice(Math.max(0, i - 60), i);
    if (prior.length < 5) continue;
    const avgVol = _avg(prior, x => x.volume);
    const avgSpread = _avg(prior, x => x.high - x.low);
    const priorHigh = Math.max(...prior.map(x => x.high));
    const spread = b.high - b.low;
    if (b.close <= b.open) continue;
    if (spread <= avgSpread * 1.8) continue;
    if (b.volume <= avgVol * 2.0) continue;
    if (b.high < priorHigh * 0.985) continue;
    if (_closePos(b) > 0.6) continue;
    const lookAhead = Math.min(10, n - 1 - i);
    const nextBars = Array.from({ length: lookAhead }, (_, j) => bars[i + 1 + j]);
    const minClose = Math.min(...nextBars.map(x => x.close));
    if (!nextBars.some(x => x.close < b.close)) continue;
    if (!(minClose < b.close * 0.98)) continue;
    return { detected: true, idx: i, bar: b, arLow: minClose };
  }
  return { detected: false };
}

/** Spring is a state, not a bar: price dipped below range support and recovered. */
function detectSpring(bars, tr, zz) {
  if (!tr || !zz || zz.length < 2) return false;
  const lastClose = bars[bars.length - 1].close;
  if (lastClose < tr.bottom) return false;
  const trStart = tr.startBarIdx ?? 0;
  const zzLows = zz.filter(p => p.type === 'low' && p.index >= trStart).sort((a, b) => b.index - a.index);
  for (const low of zzLows) {
    const pivotBar = bars[low.index];
    if (!pivotBar) continue;
    if (!(pivotBar.close < tr.bottom * 0.999)) continue;
    if (lastClose > tr.bottom && lastClose > low.price) return true;
  }
  return false;
}

/** Mirror of Spring, but a wick-only poke above the top also counts. */
function detectUpthrust(bars, tr, zz) {
  if (!tr || !zz || zz.length < 2) return false;
  const lastClose = bars[bars.length - 1].close;
  if (lastClose > tr.top) return false;
  const trStart = tr.startBarIdx ?? 0;
  const zzHighs = zz.filter(p => p.type === 'high' && p.index >= trStart).sort((a, b) => b.index - a.index);
  for (const high of zzHighs) {
    const pivotBar = bars[high.index];
    if (!pivotBar) continue;
    const closedAbove = pivotBar.close > tr.top * 1.001;
    const wickAbove = high.price > tr.top * 1.001 && pivotBar.close <= tr.top;
    if (!closedAbove && !wickAbove) continue;
    if (lastClose < tr.top && lastClose < high.price) return true;
  }
  return false;
}

// ── Prior trading range ───────────────────────────────────────────────────────

/**
 * Legacy zigzag "net-flat" range finder. Used ONLY by findPriorTR — the live range uses
 * the zone/density method in analyzeWyckoff.
 */
function findTradingRangeLegacy(bars, zz) {
  const n = bars.length;
  if (zz.length < 3) return null;
  const lastClose = bars[n - 1].close;

  function tryWindow(lookback, strict) {
    const windowStart = Math.max(0, n - lookback);
    const inWindow = zz.filter(p => p.index >= windowStart);
    const inWinHighs = inWindow.filter(p => p.type === 'high');
    const inWinLows = inWindow.filter(p => p.type === 'low');
    if (inWinHighs.length < 1 || inWinLows.length < 1) return null;
    if (strict && inWinHighs.length < 2 && inWinLows.length < 2) return null;
    if (!strict && lookback <= 60 && inWinHighs.length < 2 && inWinLows.length < 2) return null;

    const pct = (a, b) => (b.price - a.price) / a.price * 100;
    const netH_full = inWinHighs.length >= 2 ? pct(inWinHighs[0], inWinHighs[inWinHighs.length - 1]) : 0;
    const netL_full = inWinLows.length >= 2 ? pct(inWinLows[0], inWinLows[inWinLows.length - 1]) : 0;
    const lastH3 = inWinHighs.slice(-3), lastL3 = inWinLows.slice(-3);
    const netH_tail = lastH3.length >= 2 ? pct(lastH3[0], lastH3[lastH3.length - 1]) : netH_full;
    const netL_tail = lastL3.length >= 2 ? pct(lastL3[0], lastL3[lastL3.length - 1]) : netL_full;
    const netH = Math.abs(netH_tail) < Math.abs(netH_full) ? netH_tail : netH_full;
    const netL = Math.abs(netL_tail) < Math.abs(netL_full) ? netL_tail : netL_full;

    if (!(Math.abs(netH) <= 5 && Math.abs(netL) <= 5)) return null;
    const top = Math.max(...inWinHighs.map(p => p.price));
    const bottom = Math.min(...inWinLows.map(p => p.price));
    if (top <= bottom) return null;
    const widthPct = Math.round((top - bottom) / bottom * 1000) / 10;
    if (widthPct < 1.5) return null;
    if (lastClose > top * 1.01 || lastClose < bottom * 0.99) return null;
    return {
      top, bottom, mid: (top + bottom) / 2, widthPct,
      startBarIdx: windowStart, barCount: n - windowStart, pivots: inWindow,
    };
  }

  let best = null;
  for (const lb of [60, 120, 180]) {
    const candidate = tryWindow(lb, true);
    if (!candidate) continue;
    if (!best) { best = candidate; continue; }
    const sameRange = candidate.top <= best.top * 1.05 && candidate.bottom >= best.bottom * 0.95;
    if (sameRange) best = candidate;
  }
  return best;
}

function findPriorTR(bars, fixedMinPct) {
  const n = bars.length;
  if (n < 120) return null;
  const lastClose = bars[n - 1].close;
  const minPct = fixedMinPct != null ? fixedMinPct : dynamicMinPct(bars);
  const fullZZ = getZigzag(bars, 3, minPct);
  if (fullZZ.length < 4) return null;

  const pivotIndices = fullZZ.map(p => p.index).filter(idx => idx >= 80 && idx <= n - 30);
  const seen = new Set();
  const candidates = [];
  for (const idx of pivotIndices) {
    for (const offset of [0, -20, -40, -60]) {
      const e = idx + offset;
      if (e >= 80 && e <= n - 30 && !seen.has(e)) { seen.add(e); candidates.push(e); }
    }
  }
  candidates.sort((a, b) => b - a);

  const allTimeHigh = Math.max(...bars.map(b => b.high));
  for (const endBar of candidates) {
    const slice = bars.slice(0, endBar);
    const zzSlice = significanceFilter(alternateFilter(detectPivots(slice, 3)), minPct);
    const tr = findTradingRangeLegacy(slice, zzSlice);
    if (!tr) continue;
    if (tr.widthPct > 40) continue;

    const afterBars = bars.slice(endBar);
    const peakAfter = Math.max(...afterBars.map(b => b.high));
    const troughAfter = Math.min(...afterBars.map(b => b.low));
    const sliceLastClose = bars[endBar - 1].close;
    const topIsSpike = tr.top > tr.bottom * 1.10 && sliceLastClose < tr.top * 0.94;
    const brokeUp = peakAfter > tr.top * 1.08 || (topIsSpike && peakAfter >= tr.top * 0.95);
    const brokeDown = troughAfter < tr.bottom * 0.92;
    const backInside = lastClose <= tr.top * 1.10 && lastClose >= tr.bottom * 0.90;
    const positionInRange = tr.top > tr.bottom ? (lastClose - tr.bottom) / (tr.top - tr.bottom) : 0.5;

    const brokeUpEffective = brokeUp && backInside;
    const brokeDownEffective = brokeDown && backInside;
    let effectiveBrokeUp = brokeUpEffective && !brokeDownEffective;
    let effectiveBrokeDown = brokeDownEffective && !brokeUpEffective;
    if (brokeUpEffective && brokeDownEffective) {
      effectiveBrokeUp = positionInRange > 0.5;
      effectiveBrokeDown = !effectiveBrokeUp;
    }
    if (!effectiveBrokeUp && !effectiveBrokeDown) continue;

    const returnPct = effectiveBrokeUp
      ? (peakAfter - lastClose) / peakAfter * 100
      : (lastClose - troughAfter) / troughAfter * 100;
    return {
      top: tr.top, bottom: tr.bottom, mid: tr.mid, widthPct: tr.widthPct,
      brokeUp: effectiveBrokeUp, brokeDown: effectiveBrokeDown,
      peakAfter, troughAfter, returnPct,
      startBarIdx: tr.startBarIdx, barCount: tr.barCount, positionInRange,
    };
  }
  return null;
}

// ── Local breakout (SOS) ──────────────────────────────────────────────────────

function detectLocalBreakout(bars) {
  const n = bars.length;
  if (n < 90) return null;
  const last90 = bars.slice(-90);
  const localZZ = getZigzag(last90, 3, dynamicMinPct(last90));
  const WINDOW = 60;
  const ws = Math.max(0, last90.length - WINDOW);
  const inW = localZZ.filter(p => p.index >= ws);
  const winH = inW.filter(p => p.type === 'high');
  const winL = inW.filter(p => p.type === 'low');
  if (winH.length < 2 || winL.length < 2) return null;

  const trTop = Math.max(...winH.map(p => p.price));
  const trBot = Math.min(...winL.map(p => p.price));
  const netH = Math.abs((winH[winH.length - 1].price - winH[0].price) / winH[0].price * 100);
  const netL = Math.abs((winL[winL.length - 1].price - winL[0].price) / winL[0].price * 100);
  if (netH >= 8 || netL >= 8) return null;

  const lastClose = bars[n - 1].close;
  if (lastClose <= trTop * 1.005) return null;

  let boIdx = -1;
  for (let i = n - 10; i < n; i++) {
    if (bars[i].close > trTop * 1.005) { boIdx = i; break; }
  }
  if (boIdx < 0) return null;

  const globalWs = n - 90 + ws;
  const rangeVolBars = bars.slice(globalWs, boIdx);
  if (rangeVolBars.length < 5) return null;
  const rangeAvgVolume = _avg(rangeVolBars, b => b.volume);
  const breakoutVolume = bars[boIdx].volume;
  const volumeRatio = breakoutVolume / rangeAvgVolume;
  if (volumeRatio < 1.5) return null;

  const preStart = Math.max(0, globalWs - 60);
  const preRangeLow = Math.min(...bars.slice(preStart, globalWs).map(b => b.low));
  const priorRallyPct = (trBot - preRangeLow) / preRangeLow * 100;
  if (priorRallyPct < 15) return null;

  return {
    top: trTop, bottom: trBot, mid: (trTop + trBot) / 2,
    widthPct: Math.round((trTop - trBot) / trBot * 1000) / 10,
    barCount: boIdx - globalWs, startBarIdx: globalWs,
    breakoutDate: bars[boIdx].date, breakoutClose: bars[boIdx].close,
    volumeRatio: Math.round(volumeRatio * 10) / 10,
    priorRallyPct: Math.round(priorRallyPct * 10) / 10,
    rangeAvgVolume: Math.round(rangeAvgVolume), breakoutVolume,
  };
}

// ── Range classifier ──────────────────────────────────────────────────────────

function classifyRange(priorDir, s) {
  if (priorDir === 'down') {
    let score = 0;
    if (s.sc) score += 2; else score -= 2;
    if (s.spring) score += 2;
    if (s.bc) score -= 1;
    if (s.pp < 0.20) score += 2;
    else if (s.pp < 0.35) score += 1;
    else if (s.pp > 0.70) score -= 2;
    else if (s.pp > 0.55) score -= 1;
    if (s.ath < -60) score += 1;
    if (s.ath > -25) score -= 1;
    if (s.vb === 'bullish') score += 1;
    if (s.vb === 'bearish') score -= 1;
    if (s.vd) score += 1;
    // Without a climax or a spring, a range in a downtrend isn't accumulation — it is a
    // pause before the next leg down. This used to carry an `s.pp >= 0.20` exemption,
    // which disabled the clamp exactly when price sat near the lows, i.e. the case where
    // a no-climax range is *most* likely re-distribution. Deliberately unconditional.
    if (!s.sc && !s.spring) score = Math.min(score, 0);
    return { phase: score > 0 ? 'Accumulation' : 'Re-Distribution', score };
  }
  let score = 0;
  if (s.bc) score += 3; else score -= 2;
  if (s.upthrust) score += (s.posInTR ?? 0.5) >= 0.6 ? -1 : 2;
  if (s.pp > 0.85) score += 2;
  else if (s.pp > 0.70) score += 1;
  else if (s.pp < 0.40) score -= 2;
  else if (s.pp < 0.55) score -= 1;
  if (s.ath > -10) score += 2;
  else if (s.ath > -20) score += 1;
  if (s.ath < -40) score -= 1;
  if (s.vd) score -= 1;
  if (s.vb === 'bearish') score += 1;
  if (s.vb === 'bullish') score -= 1;
  const genuineUTAD = s.upthrust && (s.posInTR ?? 0.5) < 0.5 && !((s.rMacro ?? 0) > 50);
  if (!s.bc && !genuineUTAD) score = Math.min(score, 0);
  return { phase: score > 0 ? 'Distribution' : 'Re-Accumulation', score };
}

// ── Main analysis ─────────────────────────────────────────────────────────────

/**
 * @param {Array<{date,open,high,low,close,volume}>} bars ascending, uniform interval
 * @param {{ minPct?: number|null, currency?: string }} [opts]
 */
function analyzeWyckoff(bars, opts = {}) {
  const n = bars.length;
  const cur = opts.currency === 'USD' ? '$' : '₹';
  if (n < MIN_BARS) return _emptyResult(bars);

  // ── 1. Zone/density range detection ────────────────────────────────────────
  function try3CandleWindow(lookback) {
    const sliceStart = Math.max(0, n - lookback);
    const slice = bars.slice(sliceStart);
    const highs = [], lows = [];
    for (let i = 1; i < slice.length - 1; i++) {
      if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
        highs.push({ index: i, price: slice[i].high, date: slice[i].date });
      }
      if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
        lows.push({ index: i, price: slice[i].low, date: slice[i].date });
      }
    }
    const minZoneMembers = lookback <= 30 ? 2 : lookback <= 60 ? 3 : lookback <= 120 ? 5 : 6;

    // Densest ±1.5% price zone: the level the most pivots cluster around.
    function densestZone(pivots) {
      if (pivots.length < minZoneMembers) return null;
      let best = null, bestN = 0;
      for (const p of pivots) {
        const members = pivots.filter(q => q.price >= p.price * 0.985 && q.price <= p.price * 1.015);
        if (members.length > bestN) { bestN = members.length; best = members; }
      }
      return bestN >= minZoneMembers ? best : null;
    }

    const resM = densestZone(highs), supM = densestZone(lows);
    if (!resM || !supM) return null;
    const top = Math.max(...resM.map(p => p.price));
    const bottom = Math.min(...supM.map(p => p.price));
    if (top <= bottom) return null;
    const rawWidthPct = (top - bottom) / bottom * 100;
    if (rawWidthPct < 3 || rawWidthPct > 15) return null;
    const density = (resM.length + supM.length) / lookback;
    if (density < 0.10) return null;
    // Temporal-clustering guard: pivots must not all sit in one tight burst.
    const rIdx = resM.map(p => p.index), sIdx = supM.map(p => p.index);
    if (Math.max(...rIdx) - Math.min(...rIdx) < 10 && Math.max(...sIdx) - Math.min(...sIdx) < 10) return null;

    const priceStep = p => (p < 10 ? 0.1 : p < 100 ? 1 : p < 1000 ? 5 : p < 10000 ? 10 : 50);
    const rBottom = Math.floor(bottom / priceStep(bottom)) * priceStep(bottom);
    const rTop = Math.ceil(top / priceStep(top)) * priceStep(top);
    const midRaw = (top + bottom) / 2;
    const rMid = Math.round(midRaw / priceStep(midRaw)) * priceStep(midRaw);
    const lastClose = bars[n - 1].close;
    // A close just outside the range is the most informative moment in Wyckoff — it is
    // what separates a Spring from a breakdown and a UTAD from a markup. Rejecting the
    // range outright on any breach threw that structure away and dropped the caller into
    // the trendless Markup/Markdown fallback. Keep the range within a tolerance and let
    // the phase layers read the breach off `brokeBelow`/`brokeAbove` and a posInTR that
    // is allowed to run outside [0, 1].
    const tol = (rTop - rBottom) * RANGE_BREACH_TOL;
    if (lastClose > rTop + tol || lastClose < rBottom - tol) return null;

    return {
      top: rTop, bottom: rBottom, mid: rMid,
      widthPct: Math.round(rawWidthPct * 10) / 10,
      lookback, density, totalMembers: resM.length + supM.length,
      windowStart: sliceStart, barCount: n - sliceStart, startBarIdx: sliceStart,
      resistanceCount: resM.length, supportCount: supM.length,
      brokeBelow: lastClose < rBottom, brokeAbove: lastClose > rTop,
    };
  }

  const candidates = [];
  for (const lb of [30, 60, 120, 180]) {
    const r = try3CandleWindow(lb);
    if (r) candidates.push(r);
  }
  candidates.sort((a, b) => (b.density ?? 0) - (a.density ?? 0));
  const tr = candidates.length > 0 ? candidates[0] : null;

  if (tr) {
    const labelFor = w => (w <= 6 ? 'Micro' : w <= 12 ? 'Inner' : 'Macro');
    const included = [];
    const kept = candidates.filter((r, i) => {
      if (i === 0) { included.push(r); return true; }
      if (!(r.bottom < tr.top && r.top > tr.bottom)) return false;
      // Dedupe: both edges within 3%, or one within 3% and the other within 5%.
      const isDuplicate = included.some(ex => {
        const tDiff = Math.abs(r.top - ex.top) / (ex.top || 1);
        const bDiff = Math.abs(r.bottom - ex.bottom) / (ex.bottom || 1);
        if (tDiff < 0.03 && bDiff < 0.03) return true;
        if (tDiff < 0.03 && bDiff < 0.05) return true;
        if (bDiff < 0.03 && tDiff < 0.05) return true;
        return false;
      });
      if (isDuplicate) return false;
      included.push(r);
      return true;
    });
    tr.levels = kept
      .slice()
      .sort((a, b) => (a.lookback ?? 0) - (b.lookback ?? 0))
      .map(r => ({
        label: labelFor(r.widthPct), lookback: r.lookback ?? 0,
        top: r.top, bottom: r.bottom, mid: r.mid, widthPct: r.widthPct,
        density: r.density ?? 0, members: r.totalMembers ?? 0, isPrimary: r === tr,
      }));
  }

  // ── 2. Prior trend ─────────────────────────────────────────────────────────
  const allTimeHigh = Math.max(...bars.map(b => b.high));
  const allTimeLow = Math.min(...bars.map(b => b.low));
  const lastClose = bars[n - 1].close;
  const pricePos = (lastClose - allTimeLow) / (allTimeHigh - allTimeLow || 1);
  const pctFromATH = (lastClose - allTimeHigh) / allTimeHigh * 100;

  // NOTE: `from` clamps at 0, so when history is shorter than the lookback this returns
  // the full-history change rather than null — r365/r504/r756 all collapse to the same
  // number on a short series. Preserved from the frontend (changing it moves phase
  // calls); surfaced to callers via meta.returnsSaturated.
  function getChg(ws, lb) {
    const from = Math.max(0, ws - lb);
    const to = Math.max(from + 2, Math.min(ws, n - 1));
    if (to - from < 10) return null;
    return (bars[to].close - bars[from].close) / bars[from].close * 100;
  }

  function calcPriorTrend(windowStart) {
    const ws = Math.min(windowStart, n - 2);
    const r126 = getChg(ws, 126) ?? 0;
    const r365 = getChg(ws, 365) ?? getChg(ws, 252) ?? r126;
    const r504 = getChg(ws, 504) ?? r365;
    const r756 = getChg(ws, 756) ?? r504;
    const rMacro = [r365, r504, r756].reduce((best, v) => (Math.abs(v) > Math.abs(best) ? v : best), r365);
    let dir;
    if (r126 <= -10 && pricePos > 0.65) dir = 'down';
    else if (r126 <= -10 && rMacro > 20 && r126 > -22 && pctFromATH > -30) dir = 'up';
    else if (r126 > 10 && rMacro > -20) dir = 'up';
    else if (rMacro < -12) dir = 'down';
    else if (rMacro > 15 && pctFromATH < -35) dir = 'down';
    else if (rMacro > 15 && pctFromATH >= -35) dir = 'up';
    else if (r126 < -5 && pctFromATH < -25) dir = 'down';
    else if (pricePos >= 0.50) dir = 'up';
    else dir = 'down';
    return { dir, r126, r365, r504, r756, rMacro };
  }

  const priorInfo = calcPriorTrend(tr ? (tr.windowStart ?? n) : n);
  const priorDir = priorInfo.dir;

  // ── 3. Phase classification ────────────────────────────────────────────────
  const trBars = tr ? bars.slice(tr.startBarIdx) : bars;
  const sc = detectSC(trBars);
  const bc = detectBC(trBars);
  const minPct = opts.minPct != null ? opts.minPct : dynamicMinPct(bars);
  const zz = getZigzag(bars, 3, minPct);
  const spring = tr ? detectSpring(bars, tr, zz) : false;
  const upthrust = tr ? detectUpthrust(bars, tr, zz) : false;
  const { volBias } = swingVolume(bars, zz);
  const volDrying = isVolDrying(bars);

  let phaseType, subPhase = '', score = 0;
  const inRange = !!tr;
  const posInTR = tr ? (lastClose - tr.bottom) / (tr.top - tr.bottom || 1) : 0;

  if (tr) {
    const classified = classifyRange(priorDir, {
      pp: pricePos, ath: pctFromATH,
      sc: sc.detected, bc: bc.detected,
      spring, upthrust, vb: volBias, vd: volDrying,
      posInTR, rMacro: priorInfo.rMacro,
    });
    phaseType = classified.phase;
    score = classified.score;
  } else {
    phaseType = priorDir === 'up' ? 'Markup' : 'Markdown';
  }

  // ── 4. Prior-range and local-breakout layers ───────────────────────────────
  const ptr = !tr ? findPriorTR(bars, minPct) : null;
  const ps = detectPS(trBars), psy = detectPSY(trBars);
  const st = detectST(trBars, sc);
  const sow = tr ? detectSOW(bars, tr.bottom, tr.top) : { detected: false };
  const localBO = !tr && !ptr ? detectLocalBreakout(bars) : null;

  // ── 5. Prior-range phase override ──────────────────────────────────────────
  if (ptr && !tr) {
    const posInPtr = (lastClose - ptr.bottom) / (ptr.top - ptr.bottom);
    if (ptr.brokeUp) {
      if (posInPtr < 0) {
        phaseType = priorDir === 'down' ? 'Markdown' : 'Re-Distribution';
        subPhase = '';
      } else if (priorDir === 'up' || (priorDir !== 'down' && posInPtr >= 0.5)) {
        phaseType = 'Re-Accumulation'; subPhase = 'SOS Pullback';
      } else {
        phaseType = 'Re-Distribution'; subPhase = 'UTAD';
      }
    } else {
      const notDeeplyBroken = pricePos > 0.30 && pctFromATH > -50;
      const brokeDownIsSpring = posInPtr >= 0
        && !(priorDir === 'down' && posInPtr < 0.4)
        && volBias !== 'bearish' && notDeeplyBroken;
      if (brokeDownIsSpring) { phaseType = 'Re-Accumulation'; subPhase = 'Spring'; }
      else { phaseType = 'Re-Distribution'; subPhase = 'LPSY'; }
    }
  }
  if (localBO) { phaseType = 'Re-Accumulation'; subPhase = 'SOS Breakout'; }

  // ── 6. Sub-phase ───────────────────────────────────────────────────────────
  if (inRange && !subPhase) {
    if (phaseType === 'Accumulation' || phaseType === 'Re-Accumulation') {
      subPhase = spring ? 'Phase C' : sc.detected ? 'Phase B' : 'Phase A';
      if (spring && posInTR > 0.6 && volBias !== 'bearish') subPhase = 'Phase D';
    }
    if (phaseType === 'Distribution' || phaseType === 'Re-Distribution') {
      subPhase = upthrust ? 'Phase C' : bc.detected ? 'Phase B' : 'Phase A';
      if (upthrust && posInTR < 0.4 && volBias !== 'bullish') subPhase = 'Phase D';
    }
  }

  // ── 7. Confidence ──────────────────────────────────────────────────────────
  const isAccum = phaseType === 'Accumulation' || phaseType === 'Re-Accumulation';
  const isDist = phaseType === 'Distribution' || phaseType === 'Re-Distribution';
  let confidence;
  if (tr) {
    confidence = 55;
    if ((tr.totalMembers ?? 0) >= 10) confidence += 10;
    if ((tr.totalMembers ?? 0) >= 16) confidence += 5;
    if ((tr.lookback ?? 0) >= 120) confidence += 5;
    if (volBias === 'bullish' && isAccum) confidence += 8;
    if (volBias === 'bearish' && isDist) confidence += 8;
    if (sc.detected && isAccum) confidence += 8;
    if (bc.detected && isDist) confidence += 8;
    if (spring) confidence += 7;
    if (upthrust) confidence += 7;
    if (volDrying) confidence += 5;
  } else if (ptr) {
    confidence = 65;
    if (ptr.returnPct > 10) confidence += 7;
    if (volBias === 'bullish' && phaseType === 'Re-Accumulation') confidence += 8;
    if (volBias === 'bearish' && phaseType === 'Re-Distribution') confidence += 8;
  } else if (localBO) {
    confidence = localBO.volumeRatio >= 2.0 ? 78 : 72;
  } else {
    confidence = Math.abs(priorInfo.r126) > 20 ? 75 : Math.abs(priorInfo.r126) > 10 ? 65 : 55;
  }
  confidence = Math.round(Math.min(95, Math.max(0, confidence)));

  // ── 8. Narrative ───────────────────────────────────────────────────────────
  const m = v => `${cur}${v.toFixed(0)}`;
  // widthPct is a number here (the frontend held it as a pre-formatted string). Render
  // it with one decimal so the prose still reads "10.0% wide", not "10% wide".
  const trDesc = tr ? `${m(tr.bottom)}–${m(tr.top)} (${tr.widthPct.toFixed(1)}% wide, ${tr.barCount} bars)` : '';
  const posInTRpct = tr ? `${(posInTR * 100).toFixed(0)}%` : '—';
  const rM = priorInfo.rMacro;

  let description = '', signal = { emoji: '⚖️', title: '', body: '', direction: 'neutral' };

  if (phaseType === 'Accumulation') {
    description = `Price is consolidating in a ${trDesc} range after a ${Math.abs(rM).toFixed(0)}% decline. Institutional buying is absorbing remaining supply at depressed prices. ${sc.detected ? 'A Selling Climax has been detected, confirming institutional absorption.' : ''} Volume is ${volDrying ? 'contracting (supply exhausted)' : 'being monitored'}.`;
    signal = { emoji: '⏳', title: 'ACCUMULATION — Building a Base', body: `Watch for a Spring below ${m(tr.bottom)} that quickly recovers. That confirms Phase C and is the optimal long entry.`, direction: 'bullish' };
  } else if (phaseType === 'Distribution') {
    description = `Price is consolidating in a ${trDesc} range at elevated levels after a ${rM.toFixed(0)}% advance. Large interests are offloading inventory. ${bc.detected ? 'A Buying Climax has been detected.' : ''}`;
    signal = { emoji: '⏳', title: 'DISTRIBUTION — Supply Building', body: `Reduce or exit longs. Watch for an Upthrust above ${m(tr.top)} that fails — Phase C short entry. Target: ${m(tr.bottom)}.`, direction: 'bearish' };
  } else if (phaseType === 'Re-Accumulation') {
    if (subPhase === 'SOS Breakout' && localBO) {
      description = `Price broke above a ${localBO.widthPct}% micro-range (${m(localBO.bottom)}–${m(localBO.top)}) on ${localBO.volumeRatio.toFixed(1)}× avg volume — a Sign of Strength confirming Re-Accumulation.`;
      signal = { emoji: '🟢', title: 'RE-ACCUMULATION — SOS Breakout', body: `Buy pullbacks that hold above ${m(localBO.bottom)}. Stop below ${m(localBO.bottom)}.`, direction: 'bullish' };
    } else if (subPhase === 'Spring' || subPhase === 'SOS Pullback') {
      const ptrRef = ptr ? `${m(ptr.bottom)}–${m(ptr.top)}` : 'prior range';
      description = `Price tested below the ${ptrRef} and recovered — a ${subPhase === 'Spring' ? 'Spring shakeout (bear trap)' : 'Sign of Strength pullback (Last Point of Support)'}. The macro trend is UP.`;
      signal = { emoji: '🟢', title: 'RE-ACCUMULATION', body: `Enter long on the recovery. Stop below the ${subPhase === 'Spring' ? 'Spring' : 'pullback'} low.`, direction: 'bullish' };
    } else {
      description = `Price is pausing in a ${trDesc} range mid-uptrend (+${rM.toFixed(0)}%). Re-Accumulation — institutions building additional positions before the next markup leg. ${spring ? 'A Spring has confirmed Phase C.' : ''}`;
      signal = { emoji: '⏸️', title: 'RE-ACCUMULATION — Next Leg Up Loading', body: `Hold longs. Buy dips to range support ${m(tr.bottom)} on drying volume${spring ? ' — Spring confirmed, highest-conviction entry' : ''}. Breakout above ${m(tr.top)} confirms next markup.`, direction: 'bullish' };
    }
  } else if (phaseType === 'Re-Distribution') {
    if (subPhase === 'UTAD' || subPhase === 'LPSY') {
      const ptrRef = ptr ? `${m(ptr.bottom)}–${m(ptr.top)}` : 'prior range';
      description = `Price ${subPhase === 'UTAD' ? 'broke above then returned inside' : 'broke below then failed to recover into'} the ${ptrRef}. Re-Distribution: the ${subPhase === 'UTAD' ? 'breakout was a bull trap (UTAD)' : 'bounce is a Last Point of Supply (LPSY)'}.`;
      signal = { emoji: '🔴', title: 'RE-DISTRIBUTION', body: `Short the ${subPhase === 'UTAD' ? 'reversal from the UTAD spike' : 'weak LPSY bounce'}.`, direction: 'bearish' };
    } else {
      description = `Price is pausing in a ${trDesc} range mid-downtrend (${rM.toFixed(0)}%). Re-Distribution — demand exhausting before next markdown. ${upthrust ? 'Upthrust confirmed Phase C.' : ''}`;
      signal = { emoji: '⏸️', title: 'RE-DISTRIBUTION — Next Leg Down Loading', body: `Short rallies to range resistance ${tr ? m(tr.top) : ''}${upthrust ? ' — Upthrust confirmed, highest-conviction short' : ''}. Breakdown below ${tr ? m(tr.bottom) : ''} confirms next markdown.`, direction: 'bearish' };
    }
  } else if (phaseType === 'Markup') {
    description = `Price is in a confirmed uptrend (+${rM.toFixed(0)}% over past year). No active trading range — demand is dominant. ${volBias === 'bullish' ? 'Volume confirms: more intensity on up-swings.' : ''}`;
    signal = { emoji: '🚀', title: 'MARKUP — Uptrend in Progress', body: 'Stay long. Trail stops below swing lows. Watch for Re-Accumulation ranges as add-to-long opportunities.', direction: 'bullish' };
  } else {
    description = `Price is in a confirmed downtrend (${rM.toFixed(0)}% over past year). No active trading range — supply is dominant. ${volBias === 'bearish' ? 'Volume confirms: more intensity on down-swings.' : ''}`;
    signal = { emoji: '📉', title: 'MARKDOWN — Downtrend in Progress', body: 'Avoid longs. Short rallies that fail at lower highs. Watch for a Selling Climax at lows.', direction: 'bearish' };
  }

  // ── 9. Events ──────────────────────────────────────────────────────────────
  // Every event carries structured `values` alongside its prose so the frontend never
  // has to regex-parse `text` (api-wyckoff.md §4.10).
  const rnd = v => Math.round(v * 100) / 100;
  const priorVals = { r126: rnd(priorInfo.r126), rMacro: rnd(rM), direction: priorDir };
  const priorText = `r126=${priorInfo.r126.toFixed(0)}% r365=${rM.toFixed(0)}% → ${priorDir}`;
  let events;

  if (inRange) {
    events = [
      { tag: 'RANGE', label: 'Trading Range', ok: true, text: `${trDesc} | Price at ${posInTRpct} of range`,
        values: { bottom: tr.bottom, top: tr.top, widthPct: tr.widthPct, barCount: tr.barCount, positionPct: Math.round(posInTR * 100) } },
      { tag: 'PRIOR', label: 'Prior Trend', ok: true, text: priorText, values: priorVals },
      ...(isAccum ? [
        { tag: 'PS', label: 'Preliminary Support', ok: ps.detected, text: ps.detected ? `PS bar: ${ps.bar.date}` : 'Watching for first demand bar after decline', values: ps.detected ? { date: ps.bar.date } : {} },
        { tag: 'SC', label: 'Selling Climax', ok: sc.detected, text: sc.detected ? `SC: ${sc.bar.date} — panic selling absorbed` : 'Watching for high-vol wide-spread down bar closing upper half', values: sc.detected ? { date: sc.bar.date } : {} },
        { tag: 'ST', label: 'Secondary Test', ok: st.detected, text: st.detected ? `ST: ${st.bar.date} — lower vol re-test` : 'Lower-vol retest of SC area needed', values: st.detected ? { date: st.bar.date } : {} },
        { tag: 'SPRING', label: 'Spring / Shakeout', ok: spring, text: spring ? 'Spring confirmed — bear trap, Phase C' : 'Watch for dip below range bottom that quickly recovers', values: { detected: spring } },
        { tag: 'SOS', label: 'Sign of Strength', ok: spring && volBias === 'bullish', text: spring ? `Vol bias: ${volBias}` : 'Wide advance on high vol after Spring', values: { volumeBias: volBias } },
        { tag: 'VOL', label: 'Volume Drying', ok: volDrying, text: volDrying ? 'Volume contracting — absorption in progress' : 'Monitor for volume contraction on downswings', values: { volumeDrying: volDrying } },
      ] : []),
      ...(isDist ? [
        { tag: 'PSY', label: 'Preliminary Supply', ok: psy.detected, text: psy.detected ? `PSY bar: ${psy.bar.date}` : 'Watching for first supply bar after advance', values: psy.detected ? { date: psy.bar.date } : {} },
        { tag: 'BC', label: 'Buying Climax', ok: bc.detected, text: bc.detected ? `BC: ${bc.bar.date} — public buying absorbed` : 'Watching for high-vol wide-spread up bar closing lower half', values: bc.detected ? { date: bc.bar.date } : {} },
        { tag: 'SOW', label: 'Sign of Weakness', ok: sow.detected, text: sow.detected ? `SOW: ${sow.bar.date} — supply dominant` : 'Wide-spread high-vol down bar closing near low', values: sow.detected ? { date: sow.bar.date } : {} },
        { tag: 'UT', label: 'Upthrust / UTAD', ok: upthrust, text: upthrust ? 'Upthrust confirmed — bull trap, Phase C' : 'Watch for spike above range top that reverses', values: { detected: upthrust } },
        { tag: 'LPSY', label: 'Last Point of Supply', ok: subPhase === 'Phase D', text: 'Feeble low-volume rally — ideal short entry', values: { subPhase } },
        { tag: 'VOL', label: 'Vol on Down-Moves', ok: volBias === 'bearish', text: `Swing vol bias: ${volBias}`, values: { volumeBias: volBias } },
      ] : []),
    ];
  } else if (ptr) {
    const posInPtr = (lastClose - ptr.bottom) / (ptr.top - ptr.bottom);
    events = [
      { tag: 'PTR', label: 'Prior Range', ok: true, text: `${m(ptr.bottom)}–${m(ptr.top)}`, values: { bottom: ptr.bottom, top: ptr.top, widthPct: ptr.widthPct } },
      { tag: 'BREAK', label: ptr.brokeUp ? 'Breakout (UTAD/SOS)' : 'Breakdown (Spring/LPSY)', ok: true,
        text: `${ptr.brokeUp ? 'Above' : 'Below'} ${m(ptr.brokeUp ? ptr.top : ptr.bottom)}, returned ${ptr.returnPct.toFixed(1)}%`,
        values: { brokeUp: ptr.brokeUp, brokeDown: ptr.brokeDown, returnPct: ptr.returnPct } },
      { tag: 'POS', label: 'Position in Range', ok: posInPtr > 0, text: `posInRange=${posInPtr.toFixed(2)}`, values: { positionInRange: posInPtr } },
      { tag: 'VOL', label: 'Volume Bias', ok: volBias !== 'neutral', text: volBias, values: { volumeBias: volBias } },
      { tag: 'PRIOR', label: 'Prior Trend', ok: true, text: priorText, values: priorVals },
    ];
  } else if (localBO) {
    events = [
      { tag: 'RANGE', label: 'Micro Range', ok: true, text: `${m(localBO.bottom)}–${m(localBO.top)} (${localBO.widthPct}% wide)`, values: { bottom: localBO.bottom, top: localBO.top, widthPct: localBO.widthPct } },
      { tag: 'SOS', label: 'SOS Breakout', ok: true, text: `${localBO.volumeRatio.toFixed(1)}× avg volume on breakout`, values: { volumeRatio: localBO.volumeRatio, breakoutDate: localBO.breakoutDate } },
      { tag: 'PRIOR', label: 'Prior Trend', ok: true, text: `r365=${rM.toFixed(0)}% — uptrend`, values: priorVals },
      { tag: 'VOL', label: 'Volume Bias', ok: volBias === 'bullish', text: volBias, values: { volumeBias: volBias } },
    ];
  } else {
    events = [
      { tag: 'STR', label: 'Structure', ok: true, text: `${phaseType} (r126=${priorInfo.r126.toFixed(0)}% r365=${rM.toFixed(0)}%)`, values: { phase: phaseType, ...priorVals } },
      { tag: 'VOL', label: 'Volume Bias', ok: volBias !== 'neutral', text: volBias, values: { volumeBias: volBias } },
      // Leads with the direction instead of trailing it with an arrow, unlike the other branches.
      { tag: 'PRIOR', label: 'Prior Trend', ok: true, text: `${priorDir} | r126=${priorInfo.r126.toFixed(0)}% r365=${rM.toFixed(0)}%`, values: priorVals },
    ];
  }

  // ── 10. Metrics ────────────────────────────────────────────────────────────
  const avgVol10 = _avg(bars.slice(-10), b => b.volume);
  const avgVolAll = _avg(bars, b => b.volume);
  const bars2yr = bars.slice(Math.max(0, n - 504));
  const high2yr = Math.max(...bars2yr.map(b => b.high));
  const low2yr = Math.min(...bars2yr.map(b => b.low));
  const sma20 = _avg(bars.slice(-20), b => b.close);

  return {
    phaseType, subPhase, confidence, score, description, signal, events,
    tr, ptr, localBO, spring, upthrust, zz, minPct,
    structure: priorDir === 'up' ? 'uptrend' : 'downtrend',
    priorStructure: priorDir, priorPctChg: priorInfo.r126, returns: priorInfo,
    sc, bc, ps, psy, st, sow, volBias, volDrying,
    lastClose, allTimeHigh, allTimeLow, pricePos, pctFromATH,
    priceChangePct: (lastClose - bars[0].close) / bars[0].close * 100,
    volumeRatio: avgVolAll > 0 ? avgVol10 / avgVolAll : 1,
    sma20,
    posIn2yrRange: (lastClose - low2yr) / (high2yr - low2yr || 1),
    nearSwingHigh2yr: lastClose >= high2yr * 0.97,
    nearSwingLow2yr: lastClose <= low2yr * 1.03,
    correctionInUptrend: priorDir === 'up' && priorInfo.r126 < -8,
    insufficientData: false,
  };
}

function _emptyResult(bars) {
  const lastClose = bars[bars.length - 1]?.close ?? 0;
  return {
    phaseType: 'Accumulation', subPhase: 'Insufficient Data', confidence: 0, score: 0,
    description: 'Not enough data.',
    signal: { emoji: '⚖️', title: 'INSUFFICIENT DATA', body: `Need at least ${MIN_BARS} bars.`, direction: 'neutral' },
    events: [], tr: null, ptr: null, localBO: null, spring: false, upthrust: false,
    zz: [], minPct: null,
    structure: 'insufficient', priorStructure: 'insufficient', priorPctChg: 0,
    returns: { r126: 0, r365: 0, r504: 0, r756: 0, rMacro: 0 },
    sc: { detected: false }, bc: { detected: false }, ps: { detected: false },
    psy: { detected: false }, st: { detected: false }, sow: { detected: false },
    volBias: 'neutral', volDrying: false,
    lastClose, allTimeHigh: 0, allTimeLow: 0, pricePos: 0.5, pctFromATH: 0,
    priceChangePct: 0, volumeRatio: 1, sma20: 0,
    posIn2yrRange: 0.5, nearSwingHigh2yr: false, nearSwingLow2yr: false,
    correctionInUptrend: false, insufficientData: true,
  };
}

// ── Chart-support derivations ─────────────────────────────────────────────────

/**
 * Structure labels (HH/LH/EH, HL/LL/EL), swing %, and event badges — all of which the
 * frontend currently recomputes inside its canvas draw loop every frame
 * (api-wyckoff.md §4.11).
 */
function decoratePivots(zz, { sc, bc, tr }) {
  const scIdx = sc?.detected ? sc.idx : null;
  const bcIdx = bc?.detected ? bc.idx : null;
  const nearestTo = idx => {
    if (idx == null || !zz.length) return null;
    return zz.reduce((best, p) => (Math.abs(p.index - idx) < Math.abs(best.index - idx) ? p : best), zz[0]);
  };
  const scPivot = nearestTo(scIdx), bcPivot = nearestTo(bcIdx);
  const lastLow = [...zz].reverse().find(p => p.type === 'low');
  const lastHigh = [...zz].reverse().find(p => p.type === 'high');

  return zz.map((p, i) => {
    const prev = i > 0 ? zz[i - 1] : null;
    const prevSame = zz.slice(0, i).reverse().find(q => q.type === p.type);
    let structureLabel = null;
    if (prevSame) {
      const chg = (p.price - prevSame.price) / prevSame.price * 100;
      // ±1.5% dead zone → "equal" high/low rather than a marginal HH/LL.
      if (Math.abs(chg) <= 1.5) structureLabel = p.type === 'high' ? 'EH' : 'EL';
      else if (p.type === 'high') structureLabel = chg > 0 ? 'HH' : 'LH';
      else structureLabel = chg > 0 ? 'HL' : 'LL';
    }
    let eventBadge = null;
    if (scPivot && p.index === scPivot.index) eventBadge = 'SC';
    else if (bcPivot && p.index === bcPivot.index) eventBadge = 'BC';
    else if (tr && lastLow && p.index === lastLow.index && p.price < tr.bottom * 1.01) eventBadge = 'SPR';
    else if (tr && lastHigh && p.index === lastHigh.index && p.price > tr.top * 0.99) eventBadge = 'UT';

    return {
      type: p.type, index: p.index, date: p.date, price: p.price,
      structureLabel,
      swingPct: prev ? Math.round((p.price - prev.price) / prev.price * 1000) / 10 : null,
      eventBadge,
    };
  });
}

function sma20Series(bars) {
  return bars.map((_, i) => {
    if (i < 19) return null;
    const sum = bars.slice(i - 19, i + 1).reduce((s, b) => s + b.close, 0);
    return Math.round(sum / 20 * 100) / 100;
  });
}

// ── Response shaping ──────────────────────────────────────────────────────────

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const detection = d => (d?.detected
  ? { detected: true, date: d.bar.date, barIdx: d.idx, price: d.bar.close, ...(d.arHigh != null ? { arHigh: d.arHigh } : {}), ...(d.arLow != null ? { arLow: d.arLow } : {}) }
  : { detected: false });

/**
 * Map the engine result onto the API shape in api-wyckoff.md §3.
 *
 * @param {object} p
 * @param {string} p.symbol
 * @param {Array} p.bars the analysed series (already era-selected)
 * @param {object} p.result output of analyzeWyckoff
 * @param {object} p.era output of selectContiguousDailyEra
 * @param {number} p.totalRows rows available before era selection
 * @param {{ chartYears?: number, includeBars?: boolean }} p.options
 * @param {{ events: Array, adjusted: boolean }} [p.splits] output of backAdjustSplits.
 *   Pass it whenever bars were adjusted — re-detecting on adjusted bars finds nothing,
 *   so omitting it would hide the corporate action the caller just corrected for.
 */
function buildWyckoffResponse({ symbol, bars, result, era, totalRows, options = {}, splits: splitInfo }) {
  const { chartYears = 3, includeBars = true } = options;
  const n = bars.length;
  const asOf = n ? bars[n - 1].date : null;
  const r = result;
  const splits = splitInfo
    ? { suspected: splitInfo.events.length > 0, events: splitInfo.events, adjusted: splitInfo.adjusted }
    : { ...detectSuspectedSplits(bars), adjusted: false };

  const response = {
    symbol,
    ticker: `${symbol}.NS`,
    currency: 'INR',
    asOf,
    barCount: n,

    meta: {
      insufficientData: r.insufficientData,
      minBarsRequired: MIN_BARS,
      barInterval: '1d',
      zigzagMinPct: r.minPct != null ? Math.round(r.minPct * 100) / 100 : null,
      engineVersion: ENGINE_VERSION,
      // Era selection: what was dropped, and why the window may look short.
      analysisStart: n ? bars[0].date : null,
      historyTruncated: era.truncated,
      droppedLeadingBars: era.droppedLeading,
      droppedTrailingBars: era.droppedTrailing,
      totalRowsAvailable: totalRows,
      // getChg clamps to index 0, so any lookback longer than the series returns the
      // full-history change instead of null. True today for every horizon past ~1y.
      returnsSaturated: { r365: n < 365, r504: n < 504, r756: n < 756 },
      // Prices are NOT split-adjusted upstream. Events corroborated by market-cap
      // continuity are back-adjusted before analysis (splitAdjusted); anything left
      // uncorroborated is reported untouched and the phase call is unreliable there,
      // because a split reads as a crash. Surface it in the UI, don't hide it.
      suspectedSplit: splits.suspected,
      suspectedSplitEvents: splits.events,
      splitAdjusted: splits.adjusted,
    },

    phase: {
      type: r.phaseType,
      subPhase: r.subPhase,
      confidence: r.confidence,
      cycleIndex: Math.max(0, WYCKOFF_CYCLE.indexOf(r.phaseType)),
      score: r.score,
      description: r.description,
    },

    signal: r.signal,

    metrics: {
      lastClose: r2(r.lastClose),
      priceChangePct: r2(r.priceChangePct),
      structure: r.structure,
      priorStructure: r.priorStructure,
      priorPctChg: r2(r.priorPctChg),
      pivotCount: r.zz.length,
      volumeBias: r.volBias,
      volumeDrying: r.volDrying,
      volumeRatio: r2(r.volumeRatio),
      sma20: r2(r.sma20),
      allTimeHigh: r2(r.allTimeHigh),
      allTimeLow: r2(r.allTimeLow),
      pricePosition: r2(r.pricePos),
      posIn2yrRange: r2(r.posIn2yrRange),
      nearSwingHigh2yr: r.nearSwingHigh2yr,
      nearSwingLow2yr: r.nearSwingLow2yr,
      correctionInUptrend: r.correctionInUptrend,
      returns: {
        r126: r2(r.returns.r126), r365: r2(r.returns.r365), r504: r2(r.returns.r504),
        r756: r2(r.returns.r756), rMacro: r2(r.returns.rMacro),
      },
      pctFromATH: r2(r.pctFromATH),
    },

    tradingRange: r.tr ? {
      top: r.tr.top, bottom: r.tr.bottom, mid: r.tr.mid, widthPct: r.tr.widthPct,
      startBarIdx: r.tr.startBarIdx, barCount: r.tr.barCount,
      positionInRange: r2((r.lastClose - r.tr.bottom) / (r.tr.top - r.tr.bottom || 1)),
      density: r2(r.tr.density), totalMembers: r.tr.totalMembers, lookback: r.tr.lookback,
      resistanceCount: r.tr.resistanceCount, supportCount: r.tr.supportCount,
      levels: (r.tr.levels || []).map(l => ({ ...l, density: r2(l.density) })),
    } : null,

    priorRange: r.ptr ? {
      top: r2(r.ptr.top), bottom: r2(r.ptr.bottom), mid: r2(r.ptr.mid), widthPct: r.ptr.widthPct,
      brokeUp: r.ptr.brokeUp, brokeDown: r.ptr.brokeDown,
      peakAfter: r2(r.ptr.peakAfter), troughAfter: r2(r.ptr.troughAfter),
      returnPct: r2(r.ptr.returnPct), positionInRange: r2(r.ptr.positionInRange),
      startBarIdx: r.ptr.startBarIdx, barCount: r.ptr.barCount,
    } : null,

    localBreakout: r.localBO ? {
      top: r2(r.localBO.top), bottom: r2(r.localBO.bottom), mid: r2(r.localBO.mid),
      widthPct: r.localBO.widthPct,
      startBarIdx: r.localBO.startBarIdx, barCount: r.localBO.barCount,
      breakoutDate: r.localBO.breakoutDate, breakoutClose: r2(r.localBO.breakoutClose),
      breakoutVolume: r.localBO.breakoutVolume, rangeAvgVolume: r.localBO.rangeAvgVolume,
      volumeRatio: r.localBO.volumeRatio, priorRallyPct: r.localBO.priorRallyPct,
    } : null,

    detections: {
      ps: detection(r.ps), sc: detection(r.sc), st: detection(r.st),
      psy: detection(r.psy), bc: detection(r.bc), sow: detection(r.sow),
      spring: { detected: r.spring }, upthrust: { detected: r.upthrust },
    },

    events: r.events,
    pivots: decoratePivots(r.zz, { sc: r.sc, bc: r.bc, tr: r.tr }),

    cycle: { phases: [...WYCKOFF_CYCLE], activeIndex: Math.max(0, WYCKOFF_CYCLE.indexOf(r.phaseType)) },
  };

  if (includeBars) {
    const keep = Math.min(n, Math.max(1, Math.round(chartYears * 252)));
    const chartBars = bars.slice(n - keep);
    const fullSma = sma20Series(bars);
    response.chart = {
      years: chartYears,
      bars: chartBars,
      sma20: fullSma.slice(n - keep),
    };
  }

  return response;
}

// ── taRuleEngine interop ──────────────────────────────────────────────────────

const TA_ENUM_PHASE = {
  'Accumulation': 'ACCUMULATION',
  'Markup': 'MARK-UP',
  'Re-Accumulation': 'RE-ACCUMULATION',
  'Distribution': 'DISTRIBUTION',
  'Markdown': 'MARK-DOWN',
  'Re-Distribution': 'RE-DISTRIBUTION',
};

/**
 * Engine phase → the frozen vocabulary in utils/taEnums.js (IndicatorRules.WYCKOFF).
 * The hyphenation differs between the two — that mismatch is the whole reason this
 * helper exists rather than an inline toUpperCase().
 */
function toTaEnumPhase(phaseType) {
  return TA_ENUM_PHASE[phaseType] || null;
}

module.exports = {
  analyzeWyckoff,
  buildWyckoffResponse,
  selectContiguousDailyEra,
  detectSuspectedSplits,
  backAdjustSplits,
  decoratePivots,
  sma20Series,
  toTaEnumPhase,
  WYCKOFF_CYCLE,
  MIN_BARS,
  ENGINE_VERSION,
  // Exported for testing
  detectPivots, alternateFilter, significanceFilter, dynamicMinPct, getZigzag,
  detectSC, detectBC, detectPS, detectPSY, detectST, detectSOW,
  detectSpring, detectUpthrust, detectLocalBreakout, findPriorTR, classifyRange,
  swingVolume, isVolDrying,
};
