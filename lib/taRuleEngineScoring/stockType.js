'use strict';

/**
 * Step 0 — Stock Type Classification
 *
 * Implements §3 of the technical-analysis-scoring-design-spec.md.
 * Evaluates six independent conditions (C1..C6), scoring Growth, Value, or Neither.
 */

function classifyStockType(inputs, dataGaps = []) {
  const {
    adx_avg_100,
    rsi_pct_above_55,
    rsi_pct_below_50,
    sma200_touch_count,
    sma200_touch_window_bars,
    sma50_upbar_pct,
    sma50_downbar_pct,
    price_vs_sma200_pct,
    wyckoff_phase,
  } = inputs;

  const phase = (wyckoff_phase || '').toUpperCase();

  // If the whole stats block is missing
  const allStatsMissing = [
    adx_avg_100,
    rsi_pct_above_55,
    rsi_pct_below_50,
    sma200_touch_count,
    sma50_upbar_pct,
    price_vs_sma200_pct,
  ].every((v) => v == null || isNaN(v));

  if (allStatsMissing) {
    dataGaps.push('Step 0 classification stats block unavailable; defaulting to Value (tied at 0-0)');
    return {
      stock_type: 'Value',
      growth_score: 0,
      value_score: 0,
      classification_note: 'Stats block unavailable - defaulted to Value (tied at 0-0)',
      wyckoff_growth_warning: null,
      conditions: {},
    };
  }

  let growthCount = 0;
  let valueCount  = 0;
  const conditions = {};

  // C1: ADX average (100 bars): > 30 -> Growth | < 25 -> Value | 25-30 -> Neither
  if (adx_avg_100 != null && !isNaN(adx_avg_100)) {
    if (adx_avg_100 > 30) {
      conditions.C1 = 'Growth';
      growthCount++;
    } else if (adx_avg_100 < 25) {
      conditions.C1 = 'Value';
      valueCount++;
    } else {
      conditions.C1 = 'Neither';
    }
  } else {
    conditions.C1 = 'Neither';
    dataGaps.push('ADX 100-bar average missing for C1');
  }

  // C2: RSI distribution: bars>55 > 60% -> Growth | bars<50 > 55% -> Value | otherwise Neither
  // Note: Handle both decimal (0.60) and percentage (60) inputs gracefully
  const rsiAbove = (rsi_pct_above_55 != null && !isNaN(rsi_pct_above_55))
    ? (rsi_pct_above_55 <= 1 ? rsi_pct_above_55 * 100 : rsi_pct_above_55)
    : null;
  const rsiBelow = (rsi_pct_below_50 != null && !isNaN(rsi_pct_below_50))
    ? (rsi_pct_below_50 <= 1 ? rsi_pct_below_50 * 100 : rsi_pct_below_50)
    : null;

  if (rsiAbove != null && rsiAbove > 60) {
    conditions.C2 = 'Growth';
    growthCount++;
  } else if (rsiBelow != null && rsiBelow > 55) {
    conditions.C2 = 'Value';
    valueCount++;
  } else {
    conditions.C2 = 'Neither';
  }

  // C3: SMA_200 touch count: <= 2 -> Growth | >= 3 -> Value
  if (sma200_touch_count != null && !isNaN(sma200_touch_count)) {
    const windowBars = sma200_touch_window_bars ?? 200;
    if (windowBars < 150) {
      dataGaps.push(`SMA_200 touch count window is only ${windowBars} bars (<200 bars); scaled reading`);
      // When window is short, don't let a low count alone force Growth
      if (sma200_touch_count <= 1 && windowBars >= 80) {
        conditions.C3 = 'Growth';
        growthCount++;
      } else if (sma200_touch_count >= 2) {
        conditions.C3 = 'Value';
        valueCount++;
      } else {
        conditions.C3 = 'Neither';
      }
    } else {
      if (sma200_touch_count <= 2) {
        conditions.C3 = 'Growth';
        growthCount++;
      } else {
        conditions.C3 = 'Value';
        valueCount++;
      }
    }
  } else {
    conditions.C3 = 'Neither';
    dataGaps.push('SMA_200 touch count missing for C3');
  }

  // C4: SMA_50 slope: up% > 60% -> Growth | down% > 60% -> Value | otherwise Neither
  const upBarPct = (sma50_upbar_pct != null && !isNaN(sma50_upbar_pct))
    ? (sma50_upbar_pct <= 1 ? sma50_upbar_pct * 100 : sma50_upbar_pct)
    : null;
  const downBarPct = (sma50_downbar_pct != null && !isNaN(sma50_downbar_pct))
    ? (sma50_downbar_pct <= 1 ? sma50_downbar_pct * 100 : sma50_downbar_pct)
    : null;

  if (upBarPct != null && upBarPct > 60) {
    conditions.C4 = 'Growth';
    growthCount++;
  } else if (downBarPct != null && downBarPct > 60) {
    conditions.C4 = 'Value';
    valueCount++;
  } else {
    conditions.C4 = 'Neither';
  }

  // C5: Price vs SMA_200 distance: above +10% -> Growth | within -10% to +10% -> Value | below -10% -> Neither
  if (price_vs_sma200_pct != null && !isNaN(price_vs_sma200_pct)) {
    if (price_vs_sma200_pct > 10) {
      conditions.C5 = 'Growth';
      growthCount++;
    } else if (price_vs_sma200_pct >= -10 && price_vs_sma200_pct <= 10) {
      conditions.C5 = 'Value';
      valueCount++;
    } else {
      conditions.C5 = 'Neither';
    }
  } else {
    conditions.C5 = 'Neither';
    dataGaps.push('Price vs SMA_200 distance missing for C5');
  }

  // C6: Wyckoff phase:
  // Markup / Re-Accumulation / Distribution -> Growth
  // Accumulation / Re-Distribution / Markdown -> Value
  // Tiebreaker: if phase = Re-Accumulation, Growth if SMA_200 distance > +10%, else Value
  if (phase === 'RE-ACCUMULATION') {
    if (price_vs_sma200_pct != null && price_vs_sma200_pct > 10) {
      conditions.C6 = 'Growth';
      growthCount++;
    } else {
      conditions.C6 = 'Value';
      valueCount++;
    }
  } else if (phase === 'MARK-UP' || phase === 'MARKUP' || phase === 'DISTRIBUTION') {
    conditions.C6 = 'Growth';
    growthCount++;
  } else if (phase === 'ACCUMULATION' || phase === 'RE-DISTRIBUTION' || phase === 'MARKDOWN') {
    conditions.C6 = 'Value';
    valueCount++;
  } else {
    conditions.C6 = 'Neither';
    dataGaps.push(`Unknown or missing Wyckoff phase "${phase}" for C6`);
  }

  // Final classification:
  // Growth if growthCount > valueCount, otherwise Value (including ties).
  let stockType = 'Value';
  let classificationNote = '';

  if (growthCount > valueCount) {
    stockType = 'Growth';
    classificationNote = 'Stock shows strong trending behaviour - classified as Growth';
  } else if (valueCount > growthCount) {
    stockType = 'Value';
    classificationNote = 'Stock shows mean-reverting behaviour - classified as Value';
  } else {
    // Tied (growthCount === valueCount)
    stockType = 'Value';
    classificationNote = 'Stock shows balanced characteristics - classified as Value (tiebreaker)';
  }

  const wyckoffGrowthWarning = (stockType === 'Growth' && phase === 'DISTRIBUTION')
    ? 'Note: Stock classified as Growth but currently in Distribution phase. Signals may be deteriorating. Treat with caution.'
    : null;

  return {
    stock_type: stockType,
    growth_score: growthCount,
    value_score: valueCount,
    classification_note: classificationNote,
    wyckoff_growth_warning: wyckoffGrowthWarning,
    conditions,
  };
}

module.exports = { classifyStockType };
