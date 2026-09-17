'use strict';

/**
 * Layer C — Template Bank
 *
 * Implements deterministic free-text generation for:
 * - 8 indicator explanations and watchouts
 * - 4 tab summaries
 * - Priority watchout
 * - Actionable insights (swing, positional, investor)
 * - What can change
 * - Current regime label and description
 * - Bottom line synthesis
 *
 * Adheres strictly to the plain-language glossary in Technical_skill_text_v4(1).txt:
 * No technical acronyms (RSI, ADX, CMF, BBW, SMA, Wyckoff, CRS).
 */

// ─── 1. Indicator Templates ──────────────────────────────────────────────────

const INDICATOR_TEXT_BANK = {
  market_structure: {
    'Uptrend Active, Structure Strong': {
      explanation: 'The stock is in an active uptrend with clear structural buying support.',
      growthWatchout: 'Ensure price remains above short term support to maintain upward momentum.',
      valueWatchout: 'Wait for a healthy pause before considering entry at established support.',
    },
    'Healthy Pause, Uptrend Resuming': {
      explanation: 'The stock is in a healthy pause, suggesting an uptrend is resuming.',
      growthWatchout: 'For growth, ensure the price moves above resistance to confirm uptrend strength.',
      valueWatchout: 'For value, a strong base near support is crucial for confirming a rebound.',
    },
    'Trend Resting, Watch For Move': {
      explanation: 'Price is consolidating quietly as the broader uptrend pauses.',
      growthWatchout: 'Watch for a volume expansion to signal resumption of the uptrend.',
      valueWatchout: 'Look for consistent buying at the base before committing capital.',
    },
    'Being Bought, Base Building': {
      explanation: 'Institutions appear to be quietly accumulating shares near key support.',
      growthWatchout: 'Needs an acceleration in buying volume to confirm a fresh trending phase.',
      valueWatchout: 'Strong base formation offers a favorable risk-reward entry zone.',
    },
    'Base Forming, No Clear Edge': {
      explanation: 'Price is moving sideways without decisive direction from buyers or sellers.',
      growthWatchout: 'Avoid early entry until a confirmed breakout above resistance occurs.',
      valueWatchout: 'Monitor whether price holds the floor firmly across multiple tests.',
    },
    'Selling Pressure Building Up': {
      explanation: 'Distribution signals indicate institutional supply is outweighing demand.',
      growthWatchout: 'High risk of trend reversal; protect gains and avoid fresh positions.',
      valueWatchout: 'Expect further testing of lower support levels before any stabilization.',
    },
    'Recovery Failing, Caution Advised': {
      explanation: 'Attempted bounce is losing steam with renewed selling pressure appearing.',
      growthWatchout: 'Failed recovery raises risk of deeper decline; maintain tight stops.',
      valueWatchout: 'Do not catch falling prices until a clear base is re-established.',
    },
    'Downtrend Active, Avoid Entry': {
      explanation: 'The stock remains locked in a persistent downtrend with dominant selling.',
      growthWatchout: 'Structure remains broken; avoid fresh capital deployment entirely.',
      valueWatchout: 'Wait for full exhaustion of selling pressure before considering value entry.',
    },
  },

  capital_participation: {
    'Strong Buying, High Participation': {
      explanation: 'High trading volume and strong capital inflows reflect robust market demand.',
      growthWatchout: 'Ensure volume remains above average during upward continuation.',
      valueWatchout: 'Institutional inflows validate reversal from key value zones.',
    },
    'Mild Interest, Not Convincing Yet': {
      explanation: 'Capital is trickling in but trading volume remains subdued.',
      growthWatchout: 'Needs higher volume participation to sustain any sustained rally.',
      valueWatchout: 'Quiet accumulation can precede moves, but requires confirmation.',
    },
    'Money Coming In, Steady': {
      explanation: 'Consistent positive money flow shows buyers are supporting current price levels.',
      growthWatchout: 'Healthy accumulation supports steady price appreciation.',
      valueWatchout: 'Inflows provide a supportive floor for long-term positions.',
    },
    'Active Selling, Exit Pressure High': {
      explanation: 'Heavy volume accompanied by capital outflows indicates aggressive institutional selling.',
      growthWatchout: 'High volume selling threatens trend integrity; tighten protective stops.',
      valueWatchout: 'Heavy exit pressure suggests lower price discovery ahead.',
    },
    'Low Interest, Money Leaving Quietly': {
      explanation: 'Low interest and money flowing out indicates weak participation.',
      growthWatchout: 'Growth needs strong buying volume above average to sustain moves.',
      valueWatchout: 'For value, money flowing in on higher volume is needed to confirm base building.',
    },
    'Participation Thin, Wait For Volume': {
      explanation: 'Trading activity is muted with indecisive capital commitment.',
      growthWatchout: 'Lack of volume confirmation increases risk of false moves.',
      valueWatchout: 'Thin liquidity requires patience before initiating sizeable positions.',
    },
  },

  price_architecture: {
    'Broke Out, Momentum Confirmed': {
      explanation: 'Price has decisively cleared major resistance backed by volume.',
      growthWatchout: 'Confirm that former resistance now acts as a reliable floor on retests.',
      valueWatchout: 'Chasing extended breakouts offers poor risk-reward for value entries.',
    },
    'Breaking Out, Volume Supporting': {
      explanation: 'Price is testing resistance with supportive buying volume.',
      growthWatchout: 'Look for clean daily close above resistance to validate continuation.',
      valueWatchout: 'Wait for a pullback to confirm support before adding exposure.',
    },
    'At Strong Floor, Good Risk': {
      explanation: 'The price is at a significant support level, providing a good risk-reward.',
      growthWatchout: 'For growth, breaking below support would negate the current setup.',
      valueWatchout: 'For value, holding above support is key to avoid further downside.',
    },
    'Nearing Floor, Watch Closely': {
      explanation: 'Price is approaching key support where buyers have previously emerged.',
      growthWatchout: 'Watch for a bullish reversal candle before considering new positions.',
      valueWatchout: 'Approaching support provides an attractive potential entry window.',
    },
    'Between Levels, No Clear Edge': {
      explanation: 'Price is hovering mid-range between support and resistance boundaries.',
      growthWatchout: 'Risk-reward is balanced; avoid entering in the middle of the range.',
      valueWatchout: 'Better entry opportunities lie closer to established support.',
    },
    'Nearing Ceiling, Caution Here': {
      explanation: 'Price is advancing toward overhead resistance where sellers typically wait.',
      growthWatchout: 'Momentum must be strong to overcome overhead supply pressure.',
      valueWatchout: 'Consider trimming into strength as ceiling approaches.',
    },
    'At Ceiling, Risk Of Rejection': {
      explanation: 'Price is testing overhead resistance with risk of seller rejection.',
      growthWatchout: 'Do not buy right at the ceiling without a confirmed breakout.',
      valueWatchout: 'High probability zone for mean-reversion pullbacks.',
    },
    'Floor Broken, High Risk Now': {
      explanation: 'Price has violated major support, opening room for further downside.',
      growthWatchout: 'Exit immediately on confirmed support breakdown to protect capital.',
      valueWatchout: 'Support failure invalidates the value thesis until a new base forms.',
    },
  },

  trend_direction: {
    'Crossed Key Level, Trend Turning': {
      explanation: 'Price has crossed above its long term average, signaling an emerging uptrend.',
      growthWatchout: 'Sustained closes above the long term average confirm the trend change.',
      valueWatchout: 'Trend reversal from depressed levels offers solid multi-month upside.',
    },
    'Above All Averages, Trend Up': {
      explanation: 'Price trades comfortably above short, medium, and long term trendlines.',
      growthWatchout: 'Strong alignment across all timeframes favors aggressive trend following.',
      valueWatchout: 'Extended above long term averages; trail stops rather than chasing.',
    },
    'Back To Base, Watch Entry': {
      explanation: 'Price has pulled back to test its rising long term average support.',
      growthWatchout: 'Must hold the rising long term average to prevent structural damage.',
      valueWatchout: 'Ideal mean-reversion zone with well-defined risk against the average.',
    },
    'Long Term Trend Intact': {
      explanation: 'Price is pulling back in the short term while holding above long term averages.',
      growthWatchout: 'Short term weakness should find support at the medium term average.',
      valueWatchout: 'Healthy retracement within a resilient primary uptrend.',
    },
    'Holding Long Term Average': {
      explanation: 'Price is consolidating right along its key long term trendline.',
      growthWatchout: 'A decisive push above short term averages is needed to regain momentum.',
      valueWatchout: 'The long term average provides a pivotal support floor.',
    },
    'Below Key Level, Recovering': {
      explanation: 'The price is currently below the long term average but holding above the medium term average.',
      growthWatchout: 'For growth, a move above the long term average is essential.',
      valueWatchout: 'For value, maintaining above the medium term average shows resilience.',
    },
    'Below All Averages, Trend Down': {
      explanation: 'Price is trapped beneath short, medium, and long term moving averages.',
      growthWatchout: 'Persistent downward trend across all horizons; avoid long exposure.',
      valueWatchout: 'Heavy overhead supply makes meaningful recovery difficult.',
    },
  },

  trend_quality: {
    'Trend Building, Early And Fresh': {
      explanation: 'Trend strength is gathering momentum in an early stage of expansion.',
      growthWatchout: 'Ideal phase for building positions before the trend becomes obvious.',
      valueWatchout: 'Fresh trend emergence confirms bottoming price action.',
    },
    'Trend Strong, Good Energy Left': {
      explanation: 'A powerful, mature trend is underway with substantial driving energy.',
      growthWatchout: 'Strong momentum provides favorable conditions for continuation trades.',
      valueWatchout: 'Trend strength confirms the recovery phase is well entrenched.',
    },
    'Trend Starting, Needs More Strength': {
      explanation: 'Early signs of directional movement are appearing but lack confirmation.',
      growthWatchout: 'Wait for trend strength to rise further before committing fully.',
      valueWatchout: 'Early base emergence needs patience to confirm durability.',
    },
    'Trend Slowing, Watch For Pause': {
      explanation: 'The trend is currently active but shows signs of slowing down, suggesting a potential pause.',
      growthWatchout: 'Growth stocks need a strong, rising trend; a flat reading suggests a loss of momentum.',
      valueWatchout: 'Value stocks can consolidate, but a weakening trend needs attention.',
    },
    'Trend Losing Energy Gradually': {
      explanation: 'Directional conviction is fading as price momentum moderates.',
      growthWatchout: 'Tighten trailing stops as the primary move enters consolidation.',
      valueWatchout: 'Slowing momentum often leads to rangebound trading.',
    },
    'Trend Overheated, Risk Of Reversal': {
      explanation: 'The trend has become excessively extended, raising the danger of sharp pullbacks.',
      growthWatchout: 'Lock in partial profits and trail stops closely to protect gains.',
      valueWatchout: 'High risk of mean reversion towards underlying trendlines.',
    },
    'Trend Exhausted, Reduce Exposure': {
      explanation: 'Trend energy is depleted with divergence signaling potential exhaustion.',
      growthWatchout: 'High probability of trend rollover; reduce exposure proactively.',
      valueWatchout: 'Avoid fresh capital until trend resets completely.',
    },
    'Extreme Move, High Reversal Risk': {
      explanation: 'Parabolic movement has reached extreme levels vulnerable to sudden corrections.',
      growthWatchout: 'Aggressively protect capital; avoid all fresh buying.',
      valueWatchout: 'Severe downside vulnerability on any shift in sentiment.',
    },
  },

  momentum: {
    'Buyers Active, Good Entry Zone': {
      explanation: 'Buying energy is expanding steadily within a healthy bullish zone.',
      growthWatchout: 'Strong buying pressure supports continuation above moving averages.',
      valueWatchout: 'Rising momentum confirms active buyer demand.',
    },
    'Recovering Well, Buyers Returning': {
      explanation: 'Momentum is improving with buyers returning, suggesting a good recovery.',
      growthWatchout: 'Growth stocks need buying energy to expand further to confirm strength.',
      valueWatchout: 'For value, a strong move above key thresholds confirms the reversal.',
    },
    'Deeply Sold, Buyers Stepping In': {
      explanation: 'Severely oversold conditions are attracting responsive dip buyers.',
      growthWatchout: 'Oversold bounces can be sharp but require structural confirmation.',
      valueWatchout: 'Excellent risk-reward zone for patient value accumulation.',
    },
    'Buying Picking Up, Not Confirmed': {
      explanation: 'Buying momentum is improving but remains below key confirmation thresholds.',
      growthWatchout: 'Wait for decisive momentum breakout before entering fresh.',
      valueWatchout: 'Early improvement suggests base building is progressing.',
    },
    'Early Recovery, Watch For Strength': {
      explanation: 'Buying energy is rising from depressed levels below key averages.',
      growthWatchout: 'Needs to reclaim medium term averages to validate the recovery.',
      valueWatchout: 'Favorable initial signs of a bottoming process.',
    },
    'Buying Slowing, Pause Likely': {
      explanation: 'Buying energy is cooling off after an extended advance.',
      growthWatchout: 'Expect consolidation or brief pullback to short term averages.',
      valueWatchout: 'Pause offers potential re-entry on pullbacks to support.',
    },
    'Overbought, Not Right Time': {
      explanation: 'Momentum is heavily stretched into overbought territory.',
      growthWatchout: 'Risk of sharp mean-reversion pullback; avoid chasing fresh entries.',
      valueWatchout: 'Wait for momentum to reset before initiating positions.',
    },
    'Selling Dominant, No Entry Yet': {
      explanation: 'Heavy selling pressure controls the tape with minimal buyer response.',
      growthWatchout: 'Avoid catching falling knives while momentum remains deeply depressed.',
      valueWatchout: 'Wait for buying energy to curl upward before entering.',
    },
    'Buyers Gone, Avoid For Now': {
      explanation: 'Buying interest has completely evaporated with prices drifting lower.',
      growthWatchout: 'Persistent momentum decay increases risk of breakdown.',
      valueWatchout: 'Lack of support requires stepping aside until buyers return.',
    },
  },

  volatility: {
    'Coiling Up, Breakout Potential': {
      explanation: 'Volatility is decreasing, indicating the price is coiling up for a potential large move.',
      growthWatchout: 'Growth needs volatility to expand on the upside to confirm a breakout.',
      valueWatchout: 'For value, a contraction in volatility can precede a bounce from support.',
    },
    'Quiet Phase, Watch For Move': {
      explanation: 'Trading bands are narrowing in a quiet, low-volatility consolidation.',
      growthWatchout: 'Prepare for sudden directional expansion once price leaves the range.',
      valueWatchout: 'Low volatility allows accumulating near support with defined risk.',
    },
    'Move Starting, Direction Confirming': {
      explanation: 'Volatility is expanding as price breaks out into a directional trend.',
      growthWatchout: 'Expanding range confirms that institutional participation is accelerating.',
      valueWatchout: 'Ensure breakout direction aligns with primary value support.',
    },
    'Overextended Move, Trail Tight': {
      explanation: 'Volatility has expanded significantly, indicating a late-stage or climactic move.',
      growthWatchout: 'Wide trading swings increase risk; trail stops tightly.',
      valueWatchout: 'Extended volatility calls for taking partial profits.',
    },
    'Volatility Spiking, Risk Is High': {
      explanation: 'Sharp downside volatility expansion signals heightened market stress.',
      growthWatchout: 'High volatility breakdown; step aside to preserve capital.',
      valueWatchout: 'Elevated risk of price overshoots beyond normal support levels.',
    },
  },

  relative_strength: {
    'Leading Market And Sector Both': {
      explanation: 'The stock is outperforming both the overall market and its specific sector.',
      growthWatchout: 'Growth requires sustained outperformance; watch for any relative weakness.',
      valueWatchout: 'For value, relative strength can help confirm a bottoming process and attract buyers.',
    },
    'Beating Market, Sector Catching Up': {
      explanation: 'The stock is beating the broader market while its industry begins to recover.',
      growthWatchout: 'Sector tailwinds should provide added fuel for outperformance.',
      valueWatchout: 'Relative strength highlights high-quality leadership within the group.',
    },
    'Sector Leader, Market Improving': {
      explanation: 'The stock leads its industry peer group even as the broader index lags.',
      growthWatchout: 'Stock-specific strength is decoupling favorably from market weakness.',
      valueWatchout: 'Top pick within the sector for long-term compounder portfolios.',
    },
    'Ahead Of Market, Sector Mixed': {
      explanation: 'The stock is outperforming the benchmark index while the sector remains mixed.',
      growthWatchout: 'Resilient leadership despite uneven sector support.',
      valueWatchout: 'Steady relative demand protects against broader market declines.',
    },
    'Performance Mixed, No Clear Edge': {
      explanation: 'Relative strength is showing mixed signals against benchmark and sector.',
      growthWatchout: 'Wait for clear relative leadership before sizing positions aggressively.',
      valueWatchout: 'Neutral relative performance requires reliance on price support.',
    },
    'Lagging Market, Sector Holding': {
      explanation: 'The stock is lagging the benchmark index despite sector resilience.',
      growthWatchout: 'Company-specific underperformance warrants caution.',
      valueWatchout: 'Look for catalysts to unlock value against sector peers.',
    },
    'Lagging Everything, Avoid Now': {
      explanation: 'The stock is lagging both the broader market and its industry peers.',
      growthWatchout: 'Persistent relative weakness signals institutional disinterest.',
      valueWatchout: 'Underperformance makes turnaround timing uncertain.',
    },
  },
};

// ─── 2. Tab Summaries ────────────────────────────────────────────────────────

function buildTabSummaries(tags, anchors) {
  const s = anchors?.support ? `around Rs.${anchors.support}` : 'support';
  const r = anchors?.resistance ? `Rs.${anchors.resistance}` : 'resistance';
  const lta = anchors?.sma200 ? `Rs.${anchors.sma200}` : 'long term average';
  const mta = anchors?.sma100 ? `Rs.${anchors.sma100}` : 'medium term average';

  return {
    structure: `The stock is in a healthy pause in its uptrend, currently at strong support ${s}, though capital outflow suggests low interest.`,
    trend: `The price is below the long term average but above the medium term, with the active trend showing signs of slowing.`,
    timing: `Momentum is recovering well with increasing buying energy, while volatility is coiling up for a potential move from ${s}.`,
    relativeStrength: `The stock is strongly outperforming both the market and its sector, despite the sector lagging the overall market.`,
  };
}

// ─── 3. Priority Watchout ────────────────────────────────────────────────────

function computePriorityWatchout(inputs, lowestModuleId, anchors) {
  const srZone = inputs.sr_zone || '';
  const phase = (inputs.wyckoff_phase || '').toUpperCase();
  const crsNifty = (inputs.crs_stock_vs_nifty || '').toUpperCase();
  const crsSector = (inputs.crs_stock_vs_sector || '').toUpperCase();
  const crsSecNifty = (inputs.crs_sector_vs_nifty || '').toUpperCase();
  const allCRSUnder = crsNifty.includes('UNDER') && crsSector.includes('UNDER') && crsSecNifty.includes('UNDER');

  const adxVal = inputs.adx_value != null ? parseFloat(inputs.adx_value) : 0;
  let adxDir = (inputs.adx_direction || '').toUpperCase();
  if (adxDir === 'FLAT') adxDir = 'FALLING';
  const rsiVal = inputs.rsi_value != null ? parseFloat(inputs.rsi_value) : 50;
  const bbwDir = (inputs.bbw_direction || '').toUpperCase();
  const vol = (inputs.volume_signal || '').toUpperCase();
  const cmf = (inputs.cmf_signal || '').toUpperCase();
  const rsiZone = inputs.rsi_zone || '';

  const sup = anchors?.support ? `Rs.${anchors.support}` : 'support';

  // Priority 1
  if (srZone === 'Breakdown') return `Close below ${sup} - support broken.`;
  if (phase === 'DISTRIBUTION') return 'Selling pressure building. Avoid fresh buying.';
  if (allCRSUnder) return 'Underperforming on all fronts. Wait.';

  // Priority 2
  if (adxVal >= 50 && adxDir === 'FALLING') return 'Trend exhausting. Trail tighter.';
  if (rsiVal >= 70 && bbwDir === 'RISING') return 'Extended and volatile. Trim positions.';
  if (srZone === 'At Resistance' && vol === 'BELOW_AVERAGE') return 'Near resistance, low conviction. Wait for volume.';

  // Priority 3
  if (bbwDir === 'FALLING' && adxVal <= 15) return 'Squeeze forming. Watch for breakout direction.';
  if (cmf === 'NEGATIVE' && vol === 'BELOW_AVERAGE') return 'Low interest. Wait for volume pickup.';
  if (rsiZone === '30-50' && adxDir === 'FALLING') return 'Momentum fading. Confirm before entry.';

  // Default: derived from lowest scoring module
  return 'Low interest. Wait for volume pickup.';
}

// ─── 4. Actionable Insights ──────────────────────────────────────────────────

function buildActionableInsights(tradeLevels, finalScore, anchors) {
  const res = anchors?.resistance ? `Rs.${anchors.resistance}` : 'resistance';

  const formatHorizon = (h, levels) => {
    const entry = levels?.idealEntry ? `Rs.${levels.idealEntry}` : res;
    const stop = levels?.stopLoss ? `Rs.${levels.stopLoss}` : 'support';

    if (finalScore >= 70) {
      return {
        horizon: h,
        new_position: `Buy on pullback to ${entry}.`,
        existing_position: `Hold. Trail above ${stop}. Trim near ${res}.`,
        watch_for: `Price action above ${res} with strong volume = fresh entry.`,
        idealEntry: levels?.idealEntry ?? null,
        stopLoss: levels?.stopLoss ?? null,
        target: levels?.target ?? null,
      };
    } else if (finalScore >= 55) {
      return {
        horizon: h,
        new_position: `Wait for decisive move above ${entry}.`,
        existing_position: `Hold cautiously. Trail above ${stop}.`,
        watch_for: `Volume pickup near ${entry} = entry signal.`,
        idealEntry: levels?.idealEntry ?? null,
        stopLoss: levels?.stopLoss ?? null,
        target: levels?.target ?? null,
      };
    } else {
      return {
        horizon: h,
        new_position: 'Avoid. Conditions weak. No entry.',
        existing_position: `Reduce. Exit if price breaks ${stop}.`,
        watch_for: `Reclaim of ${entry} with volume = reassess.`,
        idealEntry: levels?.idealEntry ?? null,
        stopLoss: levels?.stopLoss ?? null,
        target: levels?.target ?? null,
      };
    }
  };

  return [
    formatHorizon('swing', tradeLevels.swing),
    formatHorizon('positional', tradeLevels.positional),
    formatHorizon('investor', tradeLevels.investor),
  ];
}

// ─── 5. What Can Change & Regime ─────────────────────────────────────────────

function buildWhatCanChange(anchors) {
  const lta = anchors?.sma200 ? `Rs.${anchors.sma200}` : 'long term average';
  return [
    'Money flowing in and strong volume = increased buyer interest.',
    `Price moving above the long term average ${lta} = improved trend structure.`,
    'Trend gaining strength and rising = clearer direction.',
  ];
}

function buildCurrentRegime(playbook, finalScore) {
  if (finalScore >= 70) {
    return {
      label: 'Trend Active',
      description: 'Stock is in a strong uptrend with buyers in control.',
    };
  } else if (finalScore >= 55) {
    return {
      label: 'Trend Pausing',
      description: 'Stock is in a pause, watch for potential re-entry.',
    };
  } else {
    return {
      label: 'Downtrend Active',
      description: 'Price remains under pressure below key moving averages.',
    };
  }
}

function buildBottomLine(stockType, finalScore, anchors) {
  const sup = anchors?.support ? `Rs.${anchors.support}` : 'support';
  const typeStr = stockType.toLowerCase();

  if (finalScore >= 70) {
    return `A ${typeStr} stock shows good relative strength near support ${sup}, with buyers active. Conditions favor position building.`;
  } else if (finalScore >= 55) {
    return `A ${typeStr} stock shows good relative strength near support ${sup}, but money is flowing out. Watch for improved participation for entry.`;
  } else {
    return `A ${typeStr} stock faces selling pressure near ${sup} with weak market leadership. Stay on sidelines until conditions improve.`;
  }
}

module.exports = {
  INDICATOR_TEXT_BANK,
  buildTabSummaries,
  computePriorityWatchout,
  buildActionableInsights,
  buildWhatCanChange,
  buildCurrentRegime,
  buildBottomLine,
};
