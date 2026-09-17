'use strict';

const crypto = require('crypto');
const { CANDIDATE_TAGS, BANDS } = require('./constants');

/**
 * Determine the sentiment for each of the 8 indicators.
 * @returns {'positive'|'transitional'|'negative'}
 */
function getIndicatorSentiment(id, inputs, stockType, resolvedPhase) {
  const phase = resolvedPhase || (inputs.wyckoff_phase || '').toUpperCase();
  const srZone = inputs.sr_zone || '';
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();
  const adxZone = inputs.adx_zone || '';
  let adxDir = (inputs.adx_direction || '').toUpperCase();
  if (adxDir === 'FLAT') adxDir = 'FALLING';
  const rsiZone = inputs.rsi_zone || '';
  const rsiDir = (inputs.rsi_direction || '').toUpperCase();
  const bbwDir = (inputs.bbw_direction || '').toUpperCase();
  const above200 = inputs.price_vs_sma200 === 'ABOVE';
  const above100 = inputs.price_vs_sma100 === 'ABOVE';
  const above50  = inputs.price_vs_sma50 === 'ABOVE';
  const above20  = inputs.price_vs_sma20 === 'ABOVE';
  const validCross = inputs.valid_confirmed_cross_above_sma200 === true || inputs.valid_confirmed_cross_above_sma200 === 'true';

  const crsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const crsSector = (inputs.crs_stock_vs_sector || '').toUpperCase();
  const crsSecNifty = (inputs.crs_sector_vs_nifty || '').toUpperCase();

  switch (id) {
    case 'market_structure': {
      if (phase === 'MARK-UP' || phase === 'MARKUP' || phase === 'RE-ACCUMULATION') return 'positive';
      if (phase === 'DISTRIBUTION' || phase === 'MARKDOWN') return 'negative';
      return 'transitional';
    }
    case 'capital_participation': {
      if (vol === 'ABOVE_AVERAGE' && cmf === 'POSITIVE') return 'positive';
      if (vol === 'ABOVE_AVERAGE' && cmf === 'NEGATIVE') return 'negative';
      if (cmf === 'POSITIVE') return 'positive';
      return 'negative';
    }
    case 'price_architecture': {
      if (srZone === 'Confirmed Breakout' || srZone === 'At Support') return 'positive';
      if (srZone === 'Breakdown' || srZone === 'At Resistance') return 'negative';
      return 'transitional';
    }
    case 'trend_direction': {
      if ((above200 && above100 && above50 && above20) || validCross) return 'positive';
      if (!above200 && !above100) return 'negative';
      return 'transitional';
    }
    case 'trend_quality': {
      if ((adxZone === '15-25' || adxZone === '25-50') && adxDir === 'RISING' && above100) return 'positive';
      if ((adxZone === '50-70' || adxZone === '70-100') && adxDir === 'FALLING') return 'negative';
      if (adxZone === '70-100') return 'negative';
      return 'transitional';
    }
    case 'momentum': {
      if (stockType === 'Value') {
        if (rsiZone === '30-50' && rsiDir === 'RISING' && above100) return 'positive';
        if (rsiZone === '70-100') return 'negative';
        if (rsiZone === '0-30' && rsiDir === 'RISING') return 'positive';
        if (rsiZone === '0-30' && rsiDir === 'FALLING') return 'negative';
        return 'transitional';
      } else {
        if (rsiZone === '50-70' && rsiDir === 'RISING' && above100) return 'positive';
        if (rsiZone === '0-30' && rsiDir === 'FALLING') return 'negative';
        if (rsiZone === '70-100' && rsiDir === 'FALLING') return 'negative';
        return 'transitional';
      }
    }
    case 'volatility': {
      if (bbwDir === 'FALLING') return 'positive';
      if (bbwDir === 'RISING' && !above100) return 'negative';
      return 'transitional';
    }
    case 'relative_strength': {
      const outCount = [crsNifty, crsSector, crsSecNifty].filter((x) => x.includes('OUT')).length;
      if (outCount === 3) return 'positive';
      if (outCount === 0) return 'negative';
      return 'transitional';
    }
    default:
      return 'transitional';
  }
}

/**
 * Determine the indicator tag (max 6 words) for each of the 8 indicators.
 */
function getIndicatorTag(id, inputs, stockType, resolvedPhase) {
  const phase = resolvedPhase || (inputs.wyckoff_phase || '').toUpperCase();
  const srZone = inputs.sr_zone || 'Mid Range';
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();
  const adxZone = inputs.adx_zone || '15-25';
  let adxDir = (inputs.adx_direction || 'RISING').toUpperCase();
  if (adxDir === 'FLAT') adxDir = 'FALLING';
  const rsiZone = inputs.rsi_zone || '30-50';
  const rsiDir = (inputs.rsi_direction || 'RISING').toUpperCase();
  const bbwDir = (inputs.bbw_direction || 'RISING').toUpperCase();
  const above200 = inputs.price_vs_sma200 === 'ABOVE';
  const above100 = inputs.price_vs_sma100 === 'ABOVE';
  const above50  = inputs.price_vs_sma50 === 'ABOVE';
  const above20  = inputs.price_vs_sma20 === 'ABOVE';
  const validCross = inputs.valid_confirmed_cross_above_sma200 === true || inputs.valid_confirmed_cross_above_sma200 === 'true';
  const dist200 = inputs.price_vs_sma200_pct != null ? parseFloat(inputs.price_vs_sma200_pct) : null;

  const crsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const crsSector = (inputs.crs_stock_vs_sector || '').toUpperCase();
  const crsSecNifty = (inputs.crs_sector_vs_nifty || '').toUpperCase();

  switch (id) {
    case 'market_structure': {
      if (phase === 'MARK-UP' || phase === 'MARKUP') return 'Uptrend Active, Structure Strong';
      if (phase === 'RE-ACCUMULATION') {
        // Spec §6(a):
        return (adxDir === 'RISING' && cmf === 'POSITIVE')
          ? 'Healthy Pause, Uptrend Resuming'
          : 'Trend Resting, Watch For Move';
      }
      if (phase === 'ACCUMULATION') {
        // Spec §6(b):
        return (cmf === 'POSITIVE' && vol === 'ABOVE_AVERAGE')
          ? 'Being Bought, Base Building'
          : 'Base Forming, No Clear Edge';
      }
      if (phase === 'DISTRIBUTION') return 'Selling Pressure Building Up';
      if (phase === 'RE-DISTRIBUTION') return 'Recovery Failing, Caution Advised';
      if (phase === 'MARKDOWN') return 'Downtrend Active, Avoid Entry';
      return 'Base Forming, No Clear Edge';
    }

    case 'capital_participation': {
      if (vol === 'ABOVE_AVERAGE' && cmf === 'POSITIVE') return 'Strong Buying, High Participation';
      if (vol === 'BELOW_AVERAGE' && cmf === 'POSITIVE') return 'Mild Interest, Not Convincing Yet';
      if (cmf === 'POSITIVE') return 'Money Coming In, Steady';
      if (vol === 'ABOVE_AVERAGE' && cmf !== 'POSITIVE') return 'Active Selling, Exit Pressure High';
      if (vol === 'BELOW_AVERAGE' && cmf !== 'POSITIVE') return 'Low Interest, Money Leaving Quietly';
      return 'Participation Thin, Wait For Volume';
    }

    case 'price_architecture': {
      if (srZone === 'Confirmed Breakout') {
        // Spec §6(c):
        return (vol === 'ABOVE_AVERAGE' && cmf === 'POSITIVE' && adxDir === 'RISING')
          ? 'Broke Out, Momentum Confirmed'
          : 'Breaking Out, Volume Supporting';
      }
      if (srZone === 'At Support') return 'At Strong Floor, Good Risk';
      if (srZone === 'Approaching Support') return 'Nearing Floor, Watch Closely';
      if (srZone === 'Approaching Resistance') return 'Nearing Ceiling, Caution Here';
      if (srZone === 'At Resistance') return 'At Ceiling, Risk Of Rejection';
      if (srZone === 'Breakdown') return 'Floor Broken, High Risk Now';
      return 'Between Levels, No Clear Edge';
    }

    case 'trend_direction': {
      if (validCross) return 'Crossed Key Level, Trend Turning';
      if (above200 && above100 && above50 && above20) return 'Above All Averages, Trend Up';
      if (stockType === 'Value' && above200 && dist200 != null && dist200 >= 0 && dist200 <= 3) {
        return 'Back To Base, Watch Entry';
      }
      if (above200 && (!above20 || !above50)) return 'Long Term Trend Intact';
      if (above200) return 'Holding Long Term Average';
      if (!above200 && above100) return 'Below Key Level, Recovering';
      if (!above200 && !above100 && !above50 && !above20) return 'Below All Averages, Trend Down';
      return 'Below Key Level, Recovering';
    }

    case 'trend_quality': {
      if (adxZone === '15-25' && adxDir === 'RISING') return 'Trend Building, Early And Fresh';
      if (adxZone === '25-50' && adxDir === 'RISING') return 'Trend Strong, Good Energy Left';
      if (adxZone === '0-15' && adxDir === 'RISING') return 'Trend Starting, Needs More Strength';
      if (adxZone === '25-50' && adxDir === 'FALLING') return 'Trend Slowing, Watch For Pause';
      if (adxZone === '15-25' && adxDir === 'FALLING') return 'Trend Losing Energy Gradually';
      if (adxZone === '50-70' && adxDir === 'RISING') return 'Trend Overheated, Risk Of Reversal';
      if (adxZone === '50-70' && adxDir === 'FALLING') return 'Trend Exhausted, Reduce Exposure';
      if (adxZone === '70-100') return 'Extreme Move, High Reversal Risk';
      return 'Trend Slowing, Watch For Pause';
    }

    case 'momentum': {
      if (stockType === 'Growth' && rsiZone === '50-70' && rsiDir === 'RISING' && above100) {
        return 'Buyers Active, Good Entry Zone';
      }
      if (stockType === 'Value' && rsiZone === '30-50' && rsiDir === 'RISING' && above100) {
        return 'Recovering Well, Buyers Returning';
      }
      if (rsiZone === '0-30' && rsiDir === 'RISING' && (srZone === 'At Support' || srZone === 'Approaching Support')) {
        return 'Deeply Sold, Buyers Stepping In';
      }
      if (rsiZone === '50-70' && rsiDir === 'RISING') return 'Buying Picking Up, Not Confirmed';
      if (rsiZone === '30-50' && rsiDir === 'RISING' && !above100) return 'Early Recovery, Watch For Strength';
      if (rsiZone === '50-70' && rsiDir === 'FALLING') return 'Buying Slowing, Pause Likely';
      if (rsiZone === '70-100') return 'Overbought, Not Right Time';
      if (rsiZone === '0-30' && rsiDir === 'FALLING') return 'Selling Dominant, No Entry Yet';
      if (rsiZone === '30-50' && rsiDir === 'FALLING' && !above100) return 'Buyers Gone, Avoid For Now';
      return 'Recovering Well, Buyers Returning';
    }

    case 'volatility': {
      if (bbwDir === 'FALLING' && (above100 || above200)) return 'Coiling Up, Breakout Potential';
      if (bbwDir === 'FALLING') return 'Quiet Phase, Watch For Move';
      if (bbwDir === 'RISING' && above200 && above100) return 'Move Starting, Direction Confirming';
      if (bbwDir === 'RISING' && !above100 && !above200) return 'Volatility Spiking, Risk Is High';
      return 'Overextended Move, Trail Tight';
    }

    case 'relative_strength': {
      const leg1 = crsNifty.includes('OUT');
      const leg2 = crsSector.includes('OUT');
      const leg3 = crsSecNifty.includes('OUT');

      if (leg1 && leg2 && leg3) return 'Leading Market And Sector Both';
      if (leg1 && leg2 && !leg3) return 'Beating Market, Sector Catching Up';
      if (leg1 && !leg2 && leg3) return 'Sector Leader, Market Improving';
      if (leg1 && !leg2 && !leg3) return 'Ahead Of Market, Sector Mixed';
      if (!leg1 && leg2 && leg3) return 'Sector Leader, Market Improving';
      if (!leg1 && leg2 && !leg3) return 'Performance Mixed, No Clear Edge';
      if (!leg1 && !leg2 && leg3) return 'Lagging Market, Sector Holding';
      return 'Lagging Everything, Avoid Now';
    }

    default:
      return 'Between Levels, No Clear Edge';
  }
}

// ─── Composite Tag Logic (§8) ────────────────────────────────────────────────

function computeDirectionFlag(previousScore, finalScore) {
  if (previousScore == null || isNaN(previousScore)) return null;

  const prev = Number(previousScore);
  const curr = Number(finalScore);

  const getBandAndTier = (s) => {
    for (const b of BANDS) {
      if (s >= b.min && s <= b.max) {
        const isTop = s >= b.topMin && s <= b.topMax;
        return { bandMin: b.min, bandMax: b.max, tier: isTop ? 'Top' : 'Bottom' };
      }
    }
    return { bandMin: 0, bandMax: 39, tier: 'Bottom' };
  };

  const prevBT = getBandAndTier(prev);
  const currBT = getBandAndTier(curr);

  // Moved into higher band
  if (currBT.bandMin > prevBT.bandMin) return 'Band Rising';
  // Moved into lower band
  if (currBT.bandMin < prevBT.bandMin) return 'Band Falling';

  // Same band, check tier transition
  if (prevBT.tier === 'Bottom' && currBT.tier === 'Top') return 'Tier Rising';
  if (prevBT.tier === 'Top' && currBT.tier === 'Bottom') return 'Tier Falling';

  return 'Flat';
}

function resolveCompositeTag(inputs, finalScore, stockType, previousScore, resolvedPhase, asOfDate) {
  const { symbol } = inputs;
  const phase = resolvedPhase || (inputs.wyckoff_phase || '').toUpperCase();
  const srZone = inputs.sr_zone || '';
  const cmf = (inputs.cmf_signal || '').toUpperCase();
  const adxVal = inputs.adx_value != null ? parseFloat(inputs.adx_value) : 0;
  const rsiVal = inputs.rsi_value != null ? parseFloat(inputs.rsi_value) : 50;
  const bbwDir = (inputs.bbw_direction || '').toUpperCase();
  const dist200 = inputs.price_vs_sma200_pct != null ? parseFloat(inputs.price_vs_sma200_pct) : null;
  const above200 = inputs.price_vs_sma200 === 'ABOVE';

  // §8.3 Special Situation Overrides (Priority order 1..4)
  // 1. RSI<30 AND At Support AND CMF POSITIVE -> "Oversold, Base May Be Forming"
  if (rsiVal < 30 && srZone === 'At Support' && cmf === 'POSITIVE') {
    return { tag: 'Oversold, Base May Be Forming', specialSituation: true, directionFlag: computeDirectionFlag(previousScore, finalScore) };
  }
  // 2. ADX>50 AND RSI>70 AND BBW Rising -> "Overheated, Trim And Trail"
  if (adxVal > 50 && rsiVal > 70 && bbwDir === 'RISING') {
    return { tag: 'Overheated, Trim And Trail', specialSituation: true, directionFlag: computeDirectionFlag(previousScore, finalScore) };
  }
  // 3. final_score>55 AND stock_type=Value AND price within 3% of SMA_200 from above -> "Value Entry Zone, Watch Closely"
  if (finalScore > 55 && stockType === 'Value' && above200 && dist200 != null && dist200 >= 0 && dist200 <= 3) {
    return { tag: 'Value Entry Zone, Watch Closely', specialSituation: true, directionFlag: computeDirectionFlag(previousScore, finalScore) };
  }
  // 4. phase=Re-Accumulation AND final_score in 55-75 -> "Trend Pausing, Re-Entry Forming"
  if (phase === 'RE-ACCUMULATION' && finalScore >= 55 && finalScore <= 75) {
    return { tag: 'Trend Pausing, Re-Entry Forming', specialSituation: true, directionFlag: computeDirectionFlag(previousScore, finalScore) };
  }

  const directionFlag = computeDirectionFlag(previousScore, finalScore);

  // Band key selection
  let bandKey = '55-69_Bottom_Flat';

  if (finalScore >= 85) {
    const isTop = finalScore >= 93;
    if (directionFlag === 'Band Rising') {
      bandKey = '85-100_Band_Rising';
    } else if (directionFlag === 'Tier Falling') {
      bandKey = '85-100_Tier_Falling';
    } else if (isTop) {
      bandKey = '85-100_Top_FlatOrRising';
    } else {
      bandKey = '85-100_Bottom_FlatOrRising';
    }
  } else if (finalScore >= 70) {
    const isTop = finalScore >= 78;
    if (directionFlag === 'Band Falling') {
      bandKey = '70-84_Band_Falling';
    } else if (directionFlag === 'Tier Falling') {
      bandKey = '70-84_Tier_Falling';
    } else if (directionFlag === 'Tier Rising') {
      bandKey = '70-84_Tier_Rising';
    } else if (isTop) {
      bandKey = '70-84_Top_FlatOrRising';
    } else {
      bandKey = '70-84_Bottom_Flat';
    }
  } else if (finalScore >= 55) {
    const isTop = finalScore >= 63;
    if (directionFlag === 'Band Rising') {
      bandKey = '55-69_Band_Rising';
    } else if (directionFlag === 'Band Falling') {
      bandKey = '55-69_Band_Falling';
    } else if (directionFlag === 'Tier Falling') {
      bandKey = '55-69_Tier_Falling';
    } else if (directionFlag === 'Tier Rising') {
      bandKey = '55-69_Tier_Rising';
    } else if (isTop) {
      bandKey = '55-69_Top_Flat';
    } else {
      bandKey = '55-69_Bottom_Flat';
    }
  } else if (finalScore >= 40) {
    const isTop = finalScore >= 48;
    if (directionFlag === 'Band Rising') {
      bandKey = '40-54_Band_Rising';
    } else if (directionFlag === 'Band Falling') {
      bandKey = '40-54_Band_Falling';
    } else if (directionFlag === 'Tier Falling') {
      bandKey = '40-54_Tier_Falling';
    } else if (directionFlag === 'Tier Rising') {
      bandKey = '40-54_Tier_Rising';
    } else if (isTop) {
      bandKey = '40-54_Top_Flat';
    } else {
      bandKey = '40-54_Bottom_Flat';
    }
  } else {
    // Below 40
    const isTop = finalScore >= 33;
    if (directionFlag === 'Band Falling') {
      bandKey = 'below40_Band_Falling';
    } else if (directionFlag === 'Tier Falling') {
      bandKey = 'below40_Tier_Falling';
    } else if (directionFlag === 'Tier Rising') {
      bandKey = 'below40_Tier_Rising';
    } else if (isTop) {
      bandKey = 'below40_Top_FlatOrRising';
    } else {
      bandKey = 'below40_Bottom_Flat';
    }
  }

  const pool = CANDIDATE_TAGS[bandKey] || CANDIDATE_TAGS['55-69_Bottom_Flat'];

  // Seeded hash randomization (§8.4)
  const dateStr = asOfDate || new Date().toISOString().slice(0, 10);
  const seedString = `${symbol || 'TICKER'}|${dateStr}|${bandKey}`;
  const hash = crypto.createHash('sha256').update(seedString).digest('hex');
  const index = parseInt(hash.slice(0, 8), 16) % pool.length;
  const tag = pool[index];

  return { tag, bandKey, directionFlag, specialSituation: false };
}

module.exports = {
  getIndicatorSentiment,
  getIndicatorTag,
  computeDirectionFlag,
  resolveCompositeTag,
};
