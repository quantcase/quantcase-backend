'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function na(val) {
  return val != null ? val : 'N/A';
}

function naFloat(val) {
  return val != null && !isNaN(val) ? String(val) : 'N/A';
}

/**
 * Build the raw-indicator data block injected into {{DATA_BLOCK}}.
 *
 * The new prompt does its own scoring from raw values — we no longer pass
 * pre-classified canned text from the old rule engine lookup tables.
 * We still pass the pre-computed signals where they are direct boolean/enum
 * results (SMA positions, CRS direction, volume signal, CMF sign) since those
 * require 3-day hold logic already computed by taIndicators.
 */
function buildDataBlock(taResult) {
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

  // fundamental_type: from watchlist row if available, else Mixed
  const fundamentalType = d.meta?.fundamentalType ?? 'Mixed';

  // Price levels
  const price   = naFloat(d.price?.cmp);
  const sma20   = naFloat(d.movingAverages?.sma?.[20]);
  const sma50   = naFloat(d.movingAverages?.sma?.[50]);
  const sma100  = naFloat(d.movingAverages?.sma?.[100]);
  const sma200  = naFloat(d.movingAverages?.sma?.[200]);

  // SMA position flags (3-day hold logic already applied by taIndicators)
  const aboveSMA20  = td?.priceVsSMA20  ?? 'N/A';
  const aboveSMA50  = td?.priceVsSMA50  ?? 'N/A';
  const aboveSMA100 = td?.priceVsSMA100 ?? 'N/A';
  const aboveSMA200 = td?.priceVsSMA200 ?? 'N/A';

  // SMA50 slope — Rising if today > 10 days ago
  const _sma50Now  = parseFloat(d.movingAverages?.sma?.[50]);
  const _sma50Prev = parseFloat(d.movingAverages?.sma50Prev10);
  const sma50Slope = (!isNaN(_sma50Now) && !isNaN(_sma50Prev))
    ? (_sma50Now > _sma50Prev ? 'Rising' : 'Falling')
    : 'N/A';

  // ADX — prefer direct response fields over ruleEngine intermediary
  const adxVal   = naFloat(d.trend?.adx14 ?? tq?.adx);
  const adxBand  = tq?.adxBand  ?? 'N/A';
  const adxTrend = tq?.adxTrend ?? 'N/A';   // RISING | FALLING

  // RSI — use direct response fields (taResult.momentum.rsi.*)
  const rsiVal  = naFloat(d.momentum?.rsi?.value ?? mom?.rsi);
  const rsiZone = d.momentum?.rsi?.zone ?? mom?.rsiZone ?? 'N/A';   // 0-30 | 30-50 | 50-70 | 70-100
  const rsiDir  = d.momentum?.rsi?.trend ?? 'N/A';                  // RISING | FALLING

  // BBW
  const bbWidth    = naFloat(vol?.bbWidth);
  const bbExpanding = vol?.expanding;    // true | false | null
  const bbwDir     = bbExpanding === true ? 'Rising' : bbExpanding === false ? 'Falling' : 'N/A';

  // Volume
  const volSignal = part?.volumeSignal ?? 'N/A';   // ABOVE_AVERAGE | BELOW_AVERAGE

  // CMF
  const cmfSignal = part?.cmfSignal ?? 'N/A';      // POSITIVE | NEGATIVE
  const cmfVal    = naFloat(part?.cmf);

  // Wyckoff phase (from watchlist Google Sheet, already UPPER-CASED)
  const wyckoff = ms?.wyckoffPhase ?? 'N/A';

  // S/R zone (already classified by the existing price architecture rule)
  const srZone = ps?.zone ?? 'N/A';

  // S/R levels from supportResistance block
  // Google Sheet provides a single support and resistance price (no strength score).
  // We pass proximity % as a strength proxy for Module 1 S/R strength modifier.
  const staticSR    = d.supportResistance?.static ?? {};
  const supports    = staticSR.support    ?? [];
  const resistances = staticSR.resistance ?? [];
  const nearestSupport    = supports.length    > 0 ? supports[0]    : null;
  const nearestResistance = resistances.length > 0 ? resistances[0] : null;
  const _price = parseFloat(price);
  const supportProximityPct = (nearestSupport != null && !isNaN(_price) && _price > 0)
    ? naFloat(Math.abs((_price - nearestSupport) / _price * 100))
    : 'N/A';
  const resistanceProximityPct = (nearestResistance != null && !isNaN(_price) && _price > 0)
    ? naFloat(Math.abs((nearestResistance - _price) / _price * 100))
    : 'N/A';
  // Strength score not available from Google Sheet — use proximity as proxy:
  // proximity < 3% → treat as high-strength (>=70); proximity > 10% → low-strength (<=30)
  const supportStrengthNote = supportProximityPct === 'N/A' ? 'N/A'
    : parseFloat(supportProximityPct) < 3  ? 'HIGH (proximity < 3%)'
    : parseFloat(supportProximityPct) > 10 ? 'LOW (proximity > 10%)'
    : 'MEDIUM';

  // CRS signals
  const vsNifty  = de?.vsNifty?.signal  ?? 'N/A';   // OUTPERFORMING | UNDERPERFORMING
  const vsSector = de?.vsSector?.signal ?? 'N/A';
  // rs_sector_vs_nifty: not currently computed; pass N/A so LLM can still score
  // the other two legs (Module 5 partial match)
  const vsSectorNifty = 'N/A';

  return `=== STOCK INPUT ===
SYMBOL: ${na(d.symbol)} | SECTOR: ${na(d.meta?.macroSector)}
FUNDAMENTAL TYPE: ${fundamentalType}
PRICE: ${price}

=== SMA POSITIONS (3-day hold confirmed) ===
Price vs SMA_20:  ${aboveSMA20}
Price vs SMA_50:  ${aboveSMA50}
Price vs SMA_100: ${aboveSMA100}
Price vs SMA_200: ${aboveSMA200}
SMA_20:  ${sma20}
SMA_50:  ${sma50}
SMA_100: ${sma100}
SMA_200: ${sma200}
SMA_50 Slope (vs 10d ago): ${sma50Slope}

=== ADX ===
ADX Value: ${adxVal}
ADX Band:  ${adxBand}
ADX Trend: ${adxTrend}

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
Nearest Support:          ${nearestSupport ?? 'N/A'}
Support Proximity %:      ${supportProximityPct}
Support Strength (proxy): ${supportStrengthNote}
Nearest Resistance:       ${nearestResistance ?? 'N/A'}
Resistance Proximity %:   ${resistanceProximityPct}

=== RELATIVE STRENGTH ===
Stock vs NIFTY:  ${vsNifty}
Stock vs Sector: ${vsSector}
Sector vs NIFTY: ${vsSectorNifty}`;
}

// ─── Static fallback prompt (used only if DB promptTemplate is null) ──────────
// The DB-stored template is the live version; this is the in-code fallback.

const PROMPT_TEMPLATE = `You are a systematic quantitative equity analyst implementing Ajay's rule-based technical analysis framework.

You will receive pre-computed technical indicator data for a stock. Your job is to:
1. Score each of the 7 modules using the exact scoring rules provided
2. Generate plain-language outputs for each engine bucket (NO indicator jargon)
3. Apply playbook classification
4. Produce the complete JSON output

{{DATA_BLOCK}}

---
Respond ONLY with valid JSON. No markdown fences. Exact field names per schema.`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full prompt for decision intelligence generation.
 * @param {object} taResult   Full technicalAnalysis.analyze() result
 * @param {string|null} template  DB-stored template (uses PROMPT_TEMPLATE if null)
 */
function decisionIntelligencePrompt(taResult, template) {
  const dataBlock = buildDataBlock(taResult);
  return (template ?? PROMPT_TEMPLATE).replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { decisionIntelligencePrompt, buildDataBlock, PROMPT_TEMPLATE };
