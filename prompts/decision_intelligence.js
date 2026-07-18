'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function na(val) {
  return val != null ? val : 'N/A';
}

function naFloat(val) {
  return val != null && !isNaN(val) ? String(val) : 'N/A';
}

/**
 * RSI band in the framework's vocabulary: 0-30 | 30-50 | 50-70 | 70-100.
 *
 * Deliberately NOT sourced from taResult.momentum.rsi.zone, which speaks a different
 * vocabulary (OVERBOUGHT/OVERSOLD/NEUTRAL) that the Module 3 scoring tables cannot match.
 */
function rsiBand(v) {
  if (v == null || isNaN(v)) return 'N/A';
  if (v < 30) return '0-30';
  if (v < 50) return '30-50';
  if (v < 70) return '50-70';
  return '70-100';
}

/**
 * ADX zone in the framework's vocabulary: 0-15 | 15-25 | 25-50 | 50-70 | 70-100.
 *
 * Derived from the raw numeric rather than taRuleEngine's adxBand, which both splits at
 * 50-75/75-100 (not the framework's 50-70/70-100) and suffixes direction into the band
 * string ("25-50-FALLING"), neither of which the Module 4 table can match.
 */
function adxZone(v) {
  if (v == null || isNaN(v)) return 'N/A';
  if (v < 15) return '0-15';
  if (v < 25) return '15-25';
  if (v < 50) return '25-50';
  if (v < 70) return '50-70';
  return '70-100';
}

/**
 * Classify the S/R zone into the framework's seven names.
 *
 * Recomputed here rather than mapped from taRuleEngine's price-architecture enum, which
 * cannot express the distinctions the scoring table needs: ABOVE_RESISTANCE conflates a
 * volume-confirmed breakout with a plain drift above, and ABOVE_SUPPORT collapses
 * "Approaching Support" and "Mid Range" into one bucket.
 *
 * @returns {'Breakdown'|'At Support'|'Approaching Support'|'Confirmed Breakout'|
 *           'At Resistance'|'Approaching Resistance'|'Mid Range'|'N/A'}
 */
function classifySRZone(price, support, resistance, volSignal) {
  if (price == null || isNaN(price)) return 'N/A';

  // Support zones are evaluated before resistance zones, matching the framework's own
  // ordering. In a tight range a price can sit within 10% of BOTH levels; proximity to
  // support is the more actionable read (and carries the larger Module 1 modifier), so
  // it must not be pre-empted by the resistance branch.
  const sPct = (support != null && support > 0) ? (price - support) / support : null;
  const rPct = (resistance != null && resistance > 0) ? (price - resistance) / resistance : null;

  // Above resistance is decisive regardless of support proximity.
  if (rPct != null && rPct > 0.02) {
    // A breakout only counts as confirmed with volume behind it.
    return volSignal === 'ABOVE_AVERAGE' ? 'Confirmed Breakout' : 'Mid Range';
  }

  if (sPct != null) {
    if (sPct < -0.02) return 'Breakdown';
    if (Math.abs(sPct) <= 0.02) return 'At Support';
  }
  if (rPct != null && Math.abs(rPct) <= 0.02) return 'At Resistance';
  if (sPct != null && sPct > 0.02 && sPct <= 0.10) return 'Approaching Support';
  if (rPct != null && rPct > -0.10) return 'Approaching Resistance';

  if (sPct != null || rPct != null) return 'Mid Range';
  return 'N/A';
}

/**
 * Build the raw-indicator data block injected into {{DATA_BLOCK}}.
 *
 * The prompt does its own scoring from these raw values. Every enum emitted here must
 * match the vocabulary the prompt's scoring tables key on — see rsiBand / adxZone /
 * classifySRZone above, each of which exists because the rule engine's native vocabulary
 * does not match the framework's.
 */
function buildDataBlock(taResult, previousScore = null) {
  const d    = taResult;                                    // top-level result
  const re   = d.ruleEngine;
  const se   = re?.structureEngine;
  const te   = re?.trendEngine;
  const ti   = re?.timingEngine;
  const de   = re?.dominanceEngine?.leadership;
  const td   = te?.trendDirection;
  const tq   = te?.trendQuality;
  const mom  = ti?.momentum;
  const vol  = ti?.volatility;
  const ms   = se?.marketStructure;
  const part = se?.participation;
  const ps   = se?.priceStructure;

  // Price levels
  const price   = naFloat(d.price?.cmp);
  const sma20   = naFloat(d.movingAverages?.sma?.[20]);
  const sma50   = naFloat(d.movingAverages?.sma?.[50]);
  const sma100  = naFloat(d.movingAverages?.sma?.[100]);
  const sma200  = naFloat(d.movingAverages?.sma?.[200]);

  // SMA position flags. NOTE: these are same-bar close comparisons — there is no
  // 3-day-hold confirmation anywhere in the pipeline (taIndicators computes cmp > sma
  // for the latest bar only). The prompt is told this explicitly.
  const aboveSMA20  = td?.priceVsSMA20  ?? 'N/A';
  const aboveSMA50  = td?.priceVsSMA50  ?? 'N/A';
  const aboveSMA100 = td?.priceVsSMA100 ?? 'N/A';
  const aboveSMA200 = td?.priceVsSMA200 ?? 'N/A';

  // Percent distance from each SMA (drives the Ideal For SMA hierarchy)
  const sdp      = d.smaDistancePct ?? {};
  const sma20Pct  = naFloat(sdp.sma20);
  const sma50Pct  = naFloat(sdp.sma50);
  const sma100Pct = naFloat(sdp.sma100);
  const sma200Pct = naFloat(sdp.sma200);

  // SMA50 slope — Rising if today > 10 days ago
  const _sma50Now  = parseFloat(d.movingAverages?.sma?.[50]);
  const _sma50Prev = parseFloat(d.movingAverages?.sma50Prev10);
  const sma50Slope = (!isNaN(_sma50Now) && !isNaN(_sma50Prev))
    ? (_sma50Now > _sma50Prev ? 'Rising' : 'Falling')
    : 'N/A';

  // Confirmed cross above SMA_200 (Module 2 scores this distinctly from merely holding above)
  const validCross = d.stockType?.validSMA200Cross;
  const validCrossStr = validCross === true ? 'true'
    : validCross === false ? 'false'
    : 'N/A (insufficient history)';

  // ADX — bare zone from the numeric, direction kept separate
  const _adxNum  = d.trend?.adx14 ?? tq?.adx;
  const adxVal   = naFloat(_adxNum);
  const adxZoneStr = adxZone(parseFloat(_adxNum));
  const adxTrend = tq?.adxTrend ?? 'N/A';   // RISING | FALLING | FLAT

  // RSI — band vocabulary must match the Module 3 tables
  const _rsiNum = d.momentum?.rsi?.value ?? mom?.rsi;
  const rsiVal  = naFloat(_rsiNum);
  const rsiZone = mom?.rsiZone ?? rsiBand(parseFloat(_rsiNum));
  const rsiDir  = d.momentum?.rsi?.trend ?? 'N/A';   // RISING | FALLING

  // BBW
  const bbWidth    = naFloat(vol?.bbWidth);
  const bbExpanding = vol?.expanding;    // true | false | null
  const bbwDir     = bbExpanding === true ? 'Rising' : bbExpanding === false ? 'Falling' : 'N/A';

  // Volume & CMF
  const volSignal = part?.volumeSignal ?? 'N/A';   // ABOVE_AVERAGE | BELOW_AVERAGE
  const cmfSignal = part?.cmfSignal ?? 'N/A';      // POSITIVE | NEGATIVE
  const cmfVal    = naFloat(part?.cmf);

  // Wyckoff phase (from watchlist Google Sheet, already UPPER-CASED)
  const wyckoff = ms?.wyckoffPhase ?? 'N/A';

  // S/R levels. The Google Sheet supplies exactly one support and one resistance with no
  // strength score, so only rank 1 exists — rank 2-5 modifiers can never apply.
  const staticSR    = d.supportResistance?.static ?? {};
  const supports    = staticSR.support    ?? [];
  const resistances = staticSR.resistance ?? [];
  const nearestSupport    = supports.length    > 0 ? supports[0]    : null;
  const nearestResistance = resistances.length > 0 ? resistances[0] : null;
  const _price = parseFloat(price);

  const srZone = classifySRZone(_price, nearestSupport, nearestResistance, volSignal);

  const supportProximityPct = (nearestSupport != null && !isNaN(_price) && _price > 0)
    ? naFloat(Math.round(Math.abs((_price - nearestSupport) / _price * 100) * 100) / 100)
    : 'N/A';
  const resistanceProximityPct = (nearestResistance != null && !isNaN(_price) && _price > 0)
    ? naFloat(Math.round(Math.abs((nearestResistance - _price) / _price * 100) * 100) / 100)
    : 'N/A';
  // Strength score not available from the sheet — proximity stands in as a proxy.
  const supportStrengthNote = supportProximityPct === 'N/A' ? 'N/A'
    : parseFloat(supportProximityPct) < 3  ? 'HIGH (proximity < 3%)'
    : parseFloat(supportProximityPct) > 10 ? 'LOW (proximity > 10%)'
    : 'MEDIUM';

  // Additional numeric levels — usable for levelsToWatch and Rs. mentions, but they carry
  // no strength score so they must NOT be treated as ranked S/R for Module 1.
  const pp  = d.supportResistance?.pivotPoints ?? {};
  const fib = d.supportResistance?.fibonacci ?? [];

  // CRS signals — all three legs of the Module 5 table
  const vsNifty       = de?.vsNifty?.signal       ?? 'N/A';
  const vsSector      = de?.vsSector?.signal      ?? 'N/A';
  const vsSectorNifty = de?.vsSectorNifty?.signal ?? 'N/A';

  // Stock-type classification statistics (Step 0)
  const st = d.stockType?.stats ?? null;
  const stockTypeBlock = st
    ? `Measured over the last N available bars (price history is not gap-free, so a
"100-bar" window may span more than 100 calendar days). Thresholds still apply as written.
ADX average (last 100 bars):       ${naFloat(st.adx100Avg)}
RSI bars above 55 (last 100):      ${naFloat(st.rsiAbove55Pct)}%
RSI bars below 50 (last 100):      ${naFloat(st.rsiBelow50Pct)}%
SMA_200 touch count:               ${naFloat(st.sma200TouchCount)} (over ${st.sma200TouchWindow} bars)
SMA_50 up-bar %:                   ${naFloat(st.sma50UpPct)}%
SMA_50 down-bar %:                 ${naFloat(st.sma50DownPct)}%
Price vs SMA_200 distance:         ${naFloat(st.sma200DistancePct)}%`
    : 'NOT AVAILABLE — insufficient price history. Classify as Mixed and note the gap.';

  return `=== STOCK INPUT ===
SYMBOL: ${na(d.symbol)} | SECTOR: ${na(d.meta?.macroSector)}
PRICE: ${price}
PREVIOUS SCORE: ${previousScore != null ? previousScore : 'N/A (first reading — no direction flag)'}

=== STOCK TYPE CLASSIFICATION STATS (Step 0 inputs) ===
${stockTypeBlock}

=== SMA POSITIONS (same-bar close comparison) ===
3-Day Hold Confirmation: NOT AVAILABLE — these are single-bar comparisons.
Price vs SMA_20:  ${aboveSMA20}
Price vs SMA_50:  ${aboveSMA50}
Price vs SMA_100: ${aboveSMA100}
Price vs SMA_200: ${aboveSMA200}
SMA_20:  ${sma20}   (distance ${sma20Pct}%)
SMA_50:  ${sma50}   (distance ${sma50Pct}%)
SMA_100: ${sma100}  (distance ${sma100Pct}%)
SMA_200: ${sma200}  (distance ${sma200Pct}%)
SMA_50 Slope (vs 10d ago): ${sma50Slope}
Valid confirmed cross above SMA_200: ${validCrossStr}

=== ADX ===
ADX Value:     ${adxVal}
ADX Zone:      ${adxZoneStr}
ADX Direction: ${adxTrend}

=== RSI ===
RSI Value:     ${rsiVal}
RSI Zone:      ${rsiZone}
RSI Direction: ${rsiDir}

=== BOLLINGER BAND WIDTH ===
BBW Value:     ${bbWidth}
BBW Direction: ${bbwDir}

=== VOLUME & MONEY FLOW ===
Volume Signal: ${volSignal}
CMF Signal:    ${cmfSignal}
CMF Value:     ${cmfVal}

=== WYCKOFF PHASE ===
Phase: ${wyckoff}

=== S/R ZONE ===
Zone: ${srZone}
Nearest Support (rank 1):    ${nearestSupport ?? 'N/A'}
Support Proximity %:         ${supportProximityPct}
Support Strength (proxy):    ${supportStrengthNote}
Nearest Resistance (rank 1): ${nearestResistance ?? 'N/A'}
Resistance Proximity %:      ${resistanceProximityPct}
Ranked levels available:     1 of 5 (no strength scores in source data — rank 2-5 modifiers do not apply)

=== ADDITIONAL REFERENCE LEVELS (no strength score, NOT ranked S/R) ===
Use for levels-to-watch and Rs. mentions only. Never score these as ranked support/resistance.
Pivot: ${naFloat(pp.pivot)} | R1: ${naFloat(pp.r1)} | R2: ${naFloat(pp.r2)} | S1: ${naFloat(pp.s1)} | S2: ${naFloat(pp.s2)}
Fibonacci: ${fib.length ? fib.map((f) => naFloat(f)).join(' | ') : 'N/A'}

=== RELATIVE STRENGTH ===
Stock vs NIFTY:  ${vsNifty}
Stock vs Sector: ${vsSector}
Sector vs NIFTY: ${vsSectorNifty}`;
}

// ─── Static fallback prompt (used only if DB promptTemplate is null) ──────────
// The DB-stored template is the live version; this is the in-code fallback.

const PROMPT_TEMPLATE = `You are a systematic quantitative equity analyst implementing Ajay's rule-based technical analysis framework.

You will receive pre-computed technical indicator data for a stock. Your job is to:
1. Classify the stock type (Growth / Value / Mixed) from the Step 0 statistics
2. Score each of the 7 modules using the exact scoring rules provided
3. Generate plain-language outputs for each engine bucket (NO indicator jargon)
4. Apply playbook classification
5. Produce the complete JSON output

{{DATA_BLOCK}}

---
Respond ONLY with valid JSON. No markdown fences. Exact field names per schema.`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full prompt for decision intelligence generation.
 * @param {object} taResult   Full technicalAnalysis.analyze() result
 * @param {string|null} template  DB-stored template (uses PROMPT_TEMPLATE if null)
 * @param {number|null} previousScore  Prior final_score, for the direction flag
 */
function decisionIntelligencePrompt(taResult, template, previousScore = null) {
  const dataBlock = buildDataBlock(taResult, previousScore);
  return (template ?? PROMPT_TEMPLATE).replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = {
  decisionIntelligencePrompt,
  buildDataBlock,
  PROMPT_TEMPLATE,
  rsiBand,
  adxZone,
  classifySRZone,
};
