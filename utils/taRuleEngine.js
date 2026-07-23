'use strict';

// eslint-disable-next-line no-unused-vars
const { Buckets, Indicators, IndicatorRules } = require('./taEnums');

// ─── Indicator Rule Lookup Tables ────────────────────────────────────────────
// All text sourced verbatim from "Technicals Framework - Quantcase - Rule Engine.csv"
// Watchout sentences are split into individual array items.
// Keys match IndicatorRules enum values from taEnums.js.

const WYCKOFF_INDICATOR_RULES = {
  'ACCUMULATION': {
    growthOutput: 'Wait / Observe.\nTrack for transition into Mark-Up.',
    growthWatchouts: [
      'Price Architecture: Watchout Resistance level for a possible breakout.',
      'Capital Participation: Sustained increase in volume and CMF remains above zero.',
      'Relative Strength: Relative strength vs Index or Sector stabilizes and begins to improve.',
    ],
    valueOutput: 'Start phased buying near support with small quantity.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for bullish or bearish regime change.',
      'Capital Participation: Monitor volume spikes on up days versus down days.',
    ],
  },
  'MARK-UP': {
    growthOutput: 'Start or add position preferably on a pullback or support re-test.',
    growthWatchouts: [
      'Directional Bias: Price should continue to hold above 50 and 100 SMA.',
      'Momentum Thrust: RSI should hold above 50.',
    ],
    valueOutput: 'Hold existing positions.\nAdd only on meaningful pullbacks if valuation comfort remains.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for overall regime integrity.',
      'Momentum Thrust: Alert if RSI Crosses below 50 or 30.',
      'Price Architecture: Failure to hold prior breakout levels is a warning.',
    ],
  },
  'RE-ACCUMULATION': {
    growthOutput: 'Add to existing positions on pullbacks. Look to pyramid as the trend resumes.',
    growthWatchouts: [
      'Directional Bias: Price should continue holding above 50 and 100 SMA.',
      'Volatility Regime: Volatility Regime expansion without upside progress is cautionary.',
      'Relative Strength: Relative strength vs Index or Sector should remain stable or improve.',
      'Price Architecture: Support levels should hold.',
    ],
    valueOutput: 'Partial profit booking near resistance.\nAdd on declines near support if not fully invested.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: CMF should remain above zero.',
      'Relative Strength: Relative strength vs Index or Sector should remain stable or improve.',
      'Price Architecture: Support levels should hold.',
      'Trend Maturity: ADX Should remain above 25.',
    ],
  },
  'DISTRIBUTION': {
    growthOutput: 'Avoid fresh entries.\nReduce exposure on strength.',
    growthWatchouts: [
      'Directional Bias: Break below 50 SMA signals early weakness. Sustained trading below 100 SMA confirms deterioration.',
      'Capital Participation: Volume spikes on down days indicate selling pressure. Weak volume on rallies signals lack of demand.',
      'Relative Strength: Relative strength deterioration signals capital rotation. Failure to participate in sector rallies is a warning.',
      'Price Architecture: Support breakdown signals structural change.',
    ],
    valueOutput: 'Book partial profits.\nAvoid fresh accumulation.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Volume spikes on declines suggest institutional selling.',
      'Price Architecture: Failure to hold support or breakdown from range confirms distribution.',
    ],
  },
  'MARK-DOWN': {
    growthOutput: 'Avoid fresh entries.\nExit or reduce positions on rebounds.',
    growthWatchouts: [
      'Directional Bias: Price holding below 50 SMA confirms downtrend. Reclaim above 50 SMA signals early turnaround.',
      'Price Architecture: Support breakdown confirms downtrend. Resistance breakout signals early turnaround.',
    ],
    valueOutput: 'Avoid fresh buying.\nWait for accumulation or base formation.',
    valueWatchouts: [
      'Capital Participation: CMF moving above zero signals early accumulation.',
      'Price Architecture: Holding support levels signals base formation.',
      'Trend Maturity: ADX below 25 signals early accumulation.',
      'Directional Bias: Reclaim above 200 SMA signals regime improvement.',
    ],
  },
  'RE-DISTRIBUTION': {
    growthOutput: 'Avoid fresh entries.\nMonitor for structural repair before considering positions.',
    growthWatchouts: [
      'Directional Bias: Price holding below 100 SMA confirms continuation. Reclaim above 100 SMA signals early repair.',
      'Momentum Thrust: RSI holding below 30 confirms weakness. RSI moving above 70 signals Momentum Thrust improvement.',
      'Volatility Regime: Volatility Regime expansion on declines confirms risk. Volatility Regime contraction signals selling exhaustion.',
    ],
    valueOutput: 'Avoid fresh buying.\nWait for clear base formation before accumulating.',
    valueWatchouts: [
      'Directional Bias: Sustained trading below 200 SMA confirms bearish regime. Reclaim above 200 SMA signals regime repair.',
      'Price Architecture: Lower lows or range breakdown confirm continuation. Support stabilization or base formation signals repair attempt.',
      'Trend Maturity: Rising ADX on declines confirms strengthening downtrend. ADX contraction signals weakening downside pressure.',
    ],
  },
};

const RSI_INDICATOR_RULES = {
  '0-30': {
    growthOutput: 'Avoid fresh entries.\nWait for Momentum Thrust recovery.',
    growthWatchouts: [
      'Market Phase: Prefer Accumulation or Re-Accumulation phases. RSI weakness during Mark-Down confirms continuation.',
      'Directional Bias: Price holding below 50 SMA confirms weakness. Reclaim above 50 SMA signals Momentum Thrust repair.',
      'Capital Participation: Volume expansion on declines confirms selling pressure. Reduced sell-side volume signals exhaustion.',
      'Price Architecture: Support breakdown confirms continuation. Support holding signals base formation attempt.',
      'Volatility Regime: Volatility Regime expansion confirms risk. Volatility Regime contraction signals selling exhaustion.',
    ],
    valueOutput: 'Oversold condition noted.\nConsider phased buying if structure supports.',
    valueWatchouts: [
      'Market Phase: Prefer Accumulation or Re-Accumulation phases. RSI weakness during Mark-Down signals value trap risk.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Negative CMF confirms distribution pressure. Buying interest should emerge to validate accumulation.',
      'Price Architecture: Support holding strengthens accumulation case. Support breakdown signals structural deterioration.',
      'Volatility Regime: Volatility Regime expansion on declines increases risk. Volatility Regime contraction signals selling exhaustion.',
    ],
  },
  '30-50': {
    growthOutput: 'Neutral Momentum Thrust zone.\nWait for Momentum Thrust expansion before initiating positions.',
    growthWatchouts: [
      'Market Phase: Prefer Accumulation transitioning to Mark-Up.',
      'Directional Bias: Price reclaim above 50 SMA supports Momentum Thrust recovery.',
      'Capital Participation: Buying volume should increase as RSI improves. Weak Capital Participation signals fragile recovery.',
      'Price Architecture: Breakouts or higher lows should support recovery. Failure to sustain upside attempts is a warning.',
    ],
    valueOutput: 'Neutral Momentum Thrust zone.\nAccumulate selectively if structure is supportive.',
    valueWatchouts: [
      'Market Phase: Prefer Accumulation or Re-Accumulation phases. RSI neutrality during Distribution signals caution.',
      'Directional Bias: Watch 200 SMA for regime stability. Sustained trading below 200 SMA weakens accumulation case.',
      'Capital Participation: Buying Capital Participation should emerge as RSI stabilizes. Negative CMF signals distribution pressure.',
      'Price Architecture: Support holding strengthens accumulation thesis. Support breakdown signals structural weakness.',
    ],
  },
  '50-70': {
    growthOutput: 'Positive Momentum Thrust zone.\nInitiate or add positions with trend support.',
    growthWatchouts: [
      'Market Phase: Prefer Mark-Up or Re-Accumulation phases. Momentum Thrust strength during Distribution signals late-cycle risk.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below 50 SMA signals weakening Momentum Thrust.',
      'Capital Participation: Volume expansion should support RSI strength. Weak Capital Participation signals fragile Momentum Thrust.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Relative Strength deterioration is a warning.',
    ],
    valueOutput: 'Hold existing positions.\nAvoid aggressive buying at elevated Momentum Thrust.',
    valueWatchouts: [
      'Market Phase: Momentum Thrust strength during Distribution signals late-cycle risk.',
      'Directional Bias: Extended distance above 200 SMA reduces margin of safety.',
      'Price Architecture: Extended moves far above support reduce risk-reward comfort. Failure to hold breakout levels is a warning.',
    ],
  },
  '70-100': {
    growthOutput: 'Strong Momentum Thrust zone.\nHold positions and trail on strength.\nAdd on confirmed breakouts.',
    growthWatchouts: [
      'Market Phase: Momentum Thrust extremes during Distribution signal late-cycle risk.',
      'Directional Bias: Price should hold above 50 SMA. Break below 50 or 100 SMA signals Momentum Thrust cooling.',
      'Capital Participation: CMF below zero is a warning. Rising volume on declines signals distribution pressure.',
      'Trend Maturity: Very high ADX may signal trend climax. Falling ADX signals weakening trend strength.',
    ],
    valueOutput: 'Assess whether Momentum Thrust is signaling trend exhaustion or the start of a strong expansion phase.',
    valueWatchouts: [
      'Market Phase: Momentum Thrust extremes during Distribution signal late-cycle risk.',
      'Directional Bias: Price should hold above 50 SMA. Break below 50 or 100 SMA signals Momentum Thrust cooling.',
      'Capital Participation: CMF below zero is a warning. Rising volume on declines signals distribution pressure.',
      'Trend Maturity: Very high ADX may signal trend climax. Falling ADX signals weakening trend strength.',
    ],
  },
};

const ADX_INDICATOR_RULES = {
  '0-15': {
    growthOutput: 'Weak trend environment.\nAvoid aggressive positioning until trend strength improves.',
    growthWatchouts: [
      'Market Phase: Weak ADX during Accumulation supports base formation. Weak ADX during Distribution signals fragile structure.',
      'Capital Participation: Rising volume required to validate trend emergence. Low Capital Participation signals lack of conviction.',
      'Volatility Regime: Volatility Regime contraction supports base building. Volatility Regime expansion without trend signals instability.',
    ],
    valueOutput: 'Low trend strength detected.\nAccumulate gradually within base structures.',
    valueWatchouts: [
      'Market Phase: Weak ADX during Accumulation supports base formation. Weak ADX during Mark-Down increases trap risk.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Buying Capital Participation should emerge gradually. Persistent sell pressure signals distribution.',
      'Volatility Regime: Volatility Regime contraction supports stability. Volatility Regime expansion signals structural risk.',
    ],
  },
  '15-25-RISING': {
    growthOutput: 'Trend strength improving.\nInitiate or add positions aligned with price direction.',
    growthWatchouts: [
      'Market Phase: Rising ADX during Mark-Up supports continuation. Rising ADX during Distribution signals emerging downside risk.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals weakening structure.',
      'Momentum Thrust: RSI strength should align with rising trend strength. Weak RSI signals fragile expansion.',
      'Capital Participation: Rising volume should support trend emergence. Low Capital Participation signals weak conviction.',
      'Relative Strength: Relative strength should remain positive. Deterioration signals rotation risk.',
      'Volatility Regime: Volatility Regime expansion supports trend development. Volatility Regime instability signals risk.',
    ],
    valueOutput: 'Trend strength emerging.\nAccumulate selectively within supportive structures.',
    valueWatchouts: [
      'Market Phase: Rising ADX during Accumulation supports base resolution. Rising ADX during Mark-Down increases downside risk.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Buying Capital Participation should support trend emergence. Weak Capital Participation signals fragile conviction.',
      'Relative Strength: Stabilization supports continuation comfort. Underperformance signals weak demand.',
      'Volatility Regime: Controlled Volatility Regime supports sustainable trend. Volatility Regime spikes signal instability.',
      'Momentum Thrust: RSI strength supports continuation. Momentum Thrust extremes signal overextension risk.',
    ],
  },
  '15-25-FALLING': {
    growthOutput: 'Trend strength weakening.\nAvoid fresh entries; manage existing positions cautiously.',
    growthWatchouts: [
      'Market Phase: Falling ADX during Mark-Up signals trend fatigue. Falling ADX during Distribution signals weakening sell pressure.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals structural deterioration.',
      'Capital Participation: Declining Capital Participation signals fading conviction. Rising Capital Participation may signal re-acceleration.',
      'Relative Strength: Relative strength deterioration signals rotation risk. Stabilization signals repair attempt.',
      'Volatility Regime: Volatility Regime contraction signals consolidation phase. Volatility Regime expansion without direction signals instability.',
    ],
    valueOutput: 'Trend strength weakening.\nMonitor for base formation or accumulation opportunity.',
    valueWatchouts: [
      'Market Phase: Falling ADX during Accumulation supports base development. Falling ADX during Mark-Down may signal selling exhaustion.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Declining sell pressure supports accumulation setup. Persistent selling signals continuation risk.',
      'Volatility Regime: Volatility Regime contraction supports stabilization. Volatility Regime expansion signals structural risk.',
      'Momentum Thrust: RSI stabilization supports repair. RSI weakness signals continued deterioration.',
    ],
  },
  '25-50-RISING': {
    growthOutput: 'Strong trend environment. Check Directional Bias.\nHold positions if already have and add on continuation signals.',
    growthWatchouts: [
      'Market Phase: Rising ADX during Mark-Up supports continuation. Rising ADX during Distribution signals accelerating downside risk.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals weakening trend structure.',
      'Momentum Thrust: RSI strength should align with strong trend. Momentum Thrust divergence signals exhaustion risk.',
      'Capital Participation: Rising volume should support trend strength. Weak Capital Participation signals fragile continuation.',
      'Relative Strength: Relative strength should remain positive. Deterioration signals rotation risk.',
      'Volatility Regime: Volatility Regime expansion supports trend continuation. Volatility Regime spikes without progress signal instability.',
    ],
    valueOutput: 'Strong trend in progress.\nAvoid aggressive accumulation; prefer pullbacks.',
    valueWatchouts: [
      'Market Phase: Strong trend from Accumulation supports structural re-rating. Strong trend during Distribution signals exit liquidity risk.',
      'Directional Bias: Extended distance above 200 SMA reduces margin of safety.',
      'Capital Participation: Strong Capital Participation supports sustainability. Weak Capital Participation signals fragile expansion.',
      'Relative Strength: Excessive outperformance signals overextension risk. Stabilization supports continuation comfort.',
      'Volatility Regime: Controlled Volatility Regime supports sustainable trend. Volatility Regime spikes signal instability.',
      'Momentum Thrust: RSI extremes signal overbought risk. Moderate Momentum Thrust supports continuation.',
    ],
  },
  '25-50-FALLING': {
    growthOutput: 'Trend strength fading from elevated levels.\nAvoid fresh entries; trail and manage existing positions.',
    growthWatchouts: [
      'Market Phase: Falling ADX during Mark-Up signals trend maturity. Falling ADX during Distribution signals weakening sell pressure.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals structural deterioration.',
      'Capital Participation: Declining Capital Participation signals fading conviction. Rising Capital Participation may signal re-acceleration.',
      'Relative Strength: Relative strength deterioration signals rotation risk. Stabilization signals repair attempt.',
      'Volatility Regime: Volatility Regime contraction signals consolidation phase. Volatility Regime expansion without direction signals instability.',
    ],
    valueOutput: 'Trend maturing from strong levels.\nWait for pullbacks or base formation for accumulation.',
    valueWatchouts: [
      'Market Phase: Falling ADX after Mark-Up may precede re-accumulation. Falling ADX during Distribution signals structural risk.',
      'Capital Participation: Declining Capital Participation signals weakening conviction. Stable Capital Participation supports continuation comfort.',
      'Volatility Regime: Volatility Regime contraction supports base formation. Volatility Regime expansion signals instability.',
      'Momentum Thrust: RSI cooling from extremes supports pullback setup. Sharp RSI weakness signals deterioration risk.',
    ],
  },
  '50-75-RISING': {
    growthOutput: 'Very strong trend in progress.\nHold positions and add selectively on continuation signals.',
    growthWatchouts: [
      'Market Phase: Rising ADX during Mark-Up supports powerful continuation. Rising ADX during Distribution signals accelerating downside risk.',
      'Directional Bias: Price should hold well above 50 and 100 SMA. Break below signals early trend fatigue.',
      'Momentum Thrust: RSI strength should align with strong trend. Momentum Thrust divergence signals exhaustion risk.',
      'Relative Strength: Relative strength should remain strong. Deterioration signals rotation risk.',
      'Volatility Regime: Volatility Regime expansion supports trend acceleration. Extreme Volatility Regime signals instability risk.',
    ],
    valueOutput: 'Highly extended trend environment.\nAvoid fresh accumulation; wait for correction or base.',
    valueWatchouts: [
      'Market Phase: Very strong trend from Accumulation supports structural re-rating. Strong trend during Distribution signals exit liquidity risk.',
      'Directional Bias: Significant extension above 200 SMA reduces margin of safety.',
      'Relative Strength: Extreme outperformance signals overextension risk. Stabilization supports continuation comfort.',
      'Volatility Regime: Elevated Volatility Regime signals instability near highs. Controlled Volatility Regime supports sustainability.',
      'Momentum Thrust: RSI extremes signal overbought risk. Momentum Thrust cooling signals pullback setup.',
    ],
  },
  '50-75-FALLING': {
    growthOutput: 'Trend strength fading from extreme levels.\nTrail positions and avoid fresh entries.',
    growthWatchouts: [
      'Market Phase: Falling ADX after Mark-Up signals late-stage trend maturity. Falling ADX during Distribution signals weakening sell pressure.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals structural deterioration.',
      'Momentum Thrust: RSI divergence signals exhaustion risk. Momentum Thrust recovery signals continuation attempt.',
      'Capital Participation: Declining Capital Participation signals fading conviction. Rising Capital Participation may signal re-acceleration.',
      'Relative Strength: Relative strength deterioration signals rotation risk. Stabilization signals repair attempt.',
      'Volatility Regime: Volatility Regime contraction signals consolidation phase. Volatility Regime spikes signal instability risk.',
    ],
    valueOutput: 'Trend highly extended and cooling.\nWait for correction or base formation for accumulation.',
    valueWatchouts: [
      'Market Phase: Falling ADX after strong Mark-Up may precede re-accumulation. Falling ADX during Distribution signals structural risk.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Declining Capital Participation signals weakening conviction. Stable Capital Participation supports continuation comfort.',
      'Relative Strength: Extreme outperformance signals overextension risk. Stabilization supports accumulation comfort.',
      'Volatility Regime: Volatility Regime contraction supports base formation. Volatility Regime expansion signals instability.',
      'Momentum Thrust: RSI cooling from extremes supports pullback setup. Sharp RSI weakness signals deterioration risk.',
    ],
  },
  '75-100-RISING': {
    growthOutput: 'Extreme trend acceleration in progress.\nHold positions; add only on controlled continuation setups.',
    growthWatchouts: [
      'Market Phase: Extreme ADX during Mark-Up supports parabolic continuation. Extreme ADX during Distribution signals accelerated downside risk.',
      'Directional Bias: Price should hold well above key moving averages. Break below signals sharp trend fatigue.',
      'Momentum Thrust: RSI extremes should align with acceleration. Momentum Thrust divergence signals exhaustion risk.',
      'Capital Participation: Very strong Capital Participation should support acceleration. Capital Participation divergence signals late-stage risk.',
      'Relative Strength: Extreme outperformance supports Momentum Thrust Relative Strength. Deterioration signals rotation risk.',
      'Volatility Regime: High Volatility Regime expansion supports acceleration. Extreme Volatility Regime signals blow-off risk.',
    ],
    valueOutput: 'Parabolic trend environment.\nAvoid fresh accumulation; wait for major correction.',
    valueWatchouts: [
      'Market Phase: Extreme trend from Accumulation supports structural re-rating. Extreme trend during Distribution signals exit liquidity risk.',
      'Directional Bias: Significant extension above 200 SMA reduces margin of safety.',
      'Capital Participation: Excessive Capital Participation signals late-stage buying. Healthy Capital Participation supports sustainability.',
      'Relative Strength: Extreme outperformance signals overvaluation risk. Stabilization supports future entry comfort.',
      'Volatility Regime: Extreme Volatility Regime signals instability near highs. Volatility Regime contraction signals cooling phase.',
      'Momentum Thrust: RSI extremes signal blow-off risk. Momentum Thrust cooling signals correction setup.',
    ],
  },
  '75-100-FALLING': {
    growthOutput: 'Extreme trend exhaustion phase.\nBook partial profits and trail remaining positions.',
    growthWatchouts: [
      'Market Phase: Falling ADX after parabolic Mark-Up signals blow-off exhaustion. Falling ADX during Distribution signals weakening downside pressure.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals structural reversal risk.',
      'Momentum Thrust: RSI cooling from extremes signals exhaustion. Sharp Momentum Thrust breakdown signals reversal risk.',
      'Capital Participation: Declining Capital Participation signals trend fatigue. Capital Participation spikes on declines signal distribution.',
      'Relative Strength: Relative Strength deterioration signals capital rotation. Stabilization signals consolidation phase.',
      'Volatility Regime: Volatility Regime contraction signals cooling after blow-off. Extreme Volatility Regime spikes signal instability.',
    ],
    valueOutput: 'Post-parabolic cooling phase.\nWait for deeper correction or base formation before accumulating.',
    valueWatchouts: [
      'Market Phase: Falling ADX after extreme Mark-Up may precede re-accumulation. Falling ADX during Distribution signals structural risk.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Declining Capital Participation signals cooling demand. Stable Capital Participation supports accumulation preparation.',
      'Relative Strength: Extreme outperformance signals prior excess. Stabilization improves future entry comfort.',
      'Volatility Regime: Volatility Regime contraction supports base development. Residual Volatility Regime signals instability.',
      'Momentum Thrust: RSI cooling from extremes supports correction setup. Sharp RSI weakness signals deterioration risk.',
    ],
  },
};

const BB_INDICATOR_RULES = {
  'EXPANDING': {
    growthOutput: 'Volatility Regime expansion detected.\nAlign with the direction of the prevailing trend.',
    growthWatchouts: [
      'Market Phase: Volatility Regime expansion during Mark-Up supports continuation. Expansion during Distribution signals instability.',
      'Directional Bias: Check if price is holding above or below 50 and 100 SMA.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Deterioration signals rotation risk.',
      'Price Architecture: Breakouts with Volatility Regime expansion support continuation. Range breakdowns signal downside risk.',
    ],
    valueOutput: 'Heightened Volatility Regime detected.\nAvoid aggressive accumulation until stability returns.',
    valueWatchouts: [
      'Market Phase: Volatility Regime expansion during Distribution signals supply emergence. Expansion during Accumulation may signal base resolution.',
      'Directional Bias: Check if price is holding above or below 50 and 100 SMA.',
      'Price Architecture: Support breakdown during Volatility Regime expansion signals structural deterioration. Breakout from base signals accumulation resolution.',
      'Relative Strength: Persistent underperformance signals capital exit. Stabilization signals improving confidence.',
    ],
  },
  'CONTRACTING': {
    growthOutput: 'Volatility Regime contraction detected.\nPrepare for potential breakout expansion.',
    growthWatchouts: [
      'Market Phase: Contraction during Accumulation supports upside breakout potential. Contraction during Distribution signals breakdown risk.',
      'Directional Bias: Price holding above 50 and 100 SMA supports bullish resolution. Break below signals downside risk.',
      'Momentum Thrust: RSI holding above 50 supports upside expansion. Weak RSI signals fragile setup.',
      'Price Architecture: Range tightening near resistance supports breakout. Compression near support signals breakdown risk.',
    ],
    valueOutput: 'Volatility Regime contraction detected.\nAccumulate gradually within the base.',
    valueWatchouts: [
      'Market Phase: Contraction during Accumulation supports base formation. Contraction during Distribution signals false stability.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Price Architecture: Support holding validates base formation. Support breakdown signals structural deterioration.',
      'Trend Maturity: Low ADX supports base-building phase. Rising ADX on declines signals emerging weakness.',
    ],
  },
};

const VOLUME_INDICATOR_RULES = {
  'ABOVE_AVERAGE': {
    growthOutput: 'Capital Participation expansion detected.\nAlign positions with price direction.',
    growthWatchouts: [
      'Market Phase: High volume during Mark-Up supports continuation. High volume during Distribution signals supply emergence.',
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals sell-side pressure.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Deterioration signals capital rotation.',
      'Price Architecture: Breakouts on high volume confirm continuation. Breakdowns on high volume signal distribution.',
      'Trend Maturity: Rising ADX supports directional Capital Participation. Low ADX signals unstable expansion.',
    ],
    valueOutput: 'Heightened Capital Participation detected.\nAccumulate selectively if aligned with accumulation structure.',
    valueWatchouts: [
      'Market Phase: High volume during Accumulation supports smart money entry. High volume during Distribution signals supply emergence.',
      'Price Architecture: Support holding on high volume supports accumulation. Support breakdown on high volume signals structural deterioration.',
      'Relative Strength: Persistent underperformance despite high volume signals weak conviction. Stabilization improves accumulation comfort.',
      'Trend Maturity: Rising ADX on declines confirms strengthening downtrend. Low ADX signals selling pressure may be fading.',
    ],
  },
  'BELOW_AVERAGE': {
    growthOutput: 'Low Capital Participation detected.\nAvoid aggressive positioning until volume expands.',
    growthWatchouts: [
      'Directional Bias: Price should hold above 50 and 100 SMA. Break below signals fragile trend support.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Deterioration signals capital rotation.',
      'Price Architecture: Range consolidation on low volume supports base building. Breakdowns on low volume signal weak demand.',
      'Trend Maturity: Low ADX confirms consolidation phase. Rising ADX without volume signals unstable expansion.',
    ],
    valueOutput: 'Low Capital Participation detected.\nAccumulate gradually within the base.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Price Architecture: Support holding validates accumulation base. Support breakdown signals structural deterioration.',
      'Trend Maturity: Low ADX supports base-building phase. Rising ADX on declines signals emerging weakness.',
      'Relative Strength: Persistent underperformance signals neglect risk. Stabilization improves conviction.',
    ],
  },
};

const CMF_INDICATOR_RULES = {
  'POSITIVE': {
    growthOutput: 'Positive money flow detected.\nAlign positions with price strength.',
    growthWatchouts: [
      'Market Phase: Positive CMF during Mark-Up supports continuation. Positive CMF during Distribution may signal exit liquidity.',
      'Momentum Thrust: RSI strength should support positive money flow. Weak RSI contradicts Capital Participation strength.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Deterioration signals capital rotation.',
      'Price Architecture: Breakouts with positive CMF support continuation. Failure to sustain upside signals absorption.',
    ],
    valueOutput: 'Positive money flow detected.\nAccumulate gradually if aligned with accumulation structure.',
    valueWatchouts: [
      'Directional Bias: Watch 200 SMA for regime stability. Positive CMF below 200 SMA reduces conviction.',
      'Price Architecture: Support holding with positive CMF supports accumulation. Failure to hold breakout levels signals weak conviction.',
      'Relative Strength: Stabilization vs Index or Sector supports accumulation case. Persistent underperformance signals weak capital confidence.',
      'Volatility Regime: Controlled Volatility Regime supports steady accumulation. Volatility Regime spikes signal unstable Capital Participation.',
    ],
  },
  'NEGATIVE': {
    growthOutput: 'Negative money flow detected.\nAvoid fresh entries until Capital Participation improves.',
    growthWatchouts: [
      'Market Phase: Negative CMF during Mark-Down confirms continuation. Negative CMF during Accumulation may signal selling exhaustion.',
      'Momentum Thrust: Weak RSI should align with negative money flow. RSI recovery contradicts selling pressure.',
      'Relative Strength: Relative underperformance confirms capital exit. Stabilization signals early repair.',
      'Price Architecture: Support breakdown with negative CMF confirms distribution. Support holding signals absorption.',
      'Volatility Regime: Volatility Regime expansion on declines confirms risk. Volatility Regime contraction signals selling exhaustion.',
    ],
    valueOutput: 'Negative money flow detected.\nAvoid aggressive accumulation until selling pressure subsides.',
    valueWatchouts: [
      'Market Phase: Negative CMF during Mark-Down confirms continuation risk. Negative CMF during Accumulation may signal selling exhaustion.',
      'Price Architecture: Support breakdown with negative CMF signals structural deterioration. Support holding signals absorption.',
      'Relative Strength: Persistent underperformance signals capital exit. Stabilization improves conviction.',
      'Volatility Regime: Volatility Regime expansion on declines increases instability. Volatility Regime contraction signals selling exhaustion.',
      'Momentum Thrust: RSI weakness should align with negative money flow. RSI recovery signals early repair attempt.',
    ],
  },
};

const PRICE_ARCH_INDICATOR_RULES = {
  'BELOW_SUPPORT': {
    growthOutput: 'Support breakdown confirmed.\nAvoid fresh entries and reduce exposure.',
    growthWatchouts: [
      'Market Phase: Breakdown from Accumulation or Distribution signals structural change.',
      'Directional Bias: Price holding below 50 and 100 SMA confirms structural weakness. Reclaim above signals repair attempt.',
      'Capital Participation: Volume expansion on breakdown confirms distribution. Low volume breakdown signals weak conviction.',
      'Trend Maturity: Rising ADX on declines confirms strengthening downtrend. ADX contraction signals weakening sell pressure.',
      'Volatility Regime: Volatility Regime expansion on breakdown confirms instability. Volatility Regime contraction signals exhaustion.',
    ],
    valueOutput: 'Support breakdown detected.\nAvoid fresh accumulation until structure stabilizes.',
    valueWatchouts: [
      'Market Phase: Breakdown during Mark-Down confirms continuation risk. Breakdown during Accumulation may signal shakeout.',
      'Directional Bias: Watch 200 SMA for regime stability. Sustained trading below weakens accumulation comfort.',
      'Capital Participation: High selling volume confirms distribution pressure. Reduced sell-side volume signals exhaustion.',
      'Relative Strength: Persistent underperformance signals capital exit. Stabilization improves conviction.',
    ],
  },
  'ABOVE_RESISTANCE': {
    growthOutput: 'Resistance breakout confirmed.\nInitiate or add positions on strength.',
    growthWatchouts: [
      'Market Phase: Breakout from Accumulation supports Mark-Up transition. Breakout during Distribution signals bull trap risk.',
      'Momentum Thrust: RSI strength should align with breakout. Weak RSI signals fragile expansion.',
      'Capital Participation: Volume expansion on breakout confirms accumulation. Low volume breakout signals weak conviction.',
      'Relative Strength: Relative strength vs Index or Sector should remain positive. Deterioration signals rotation risk.',
      'Trend Maturity: Rising ADX supports breakout continuation. Low ADX signals weak trend backing.',
      'Volatility Regime: Volatility Regime expansion supports breakout expansion. Volatility Regime spikes without progress signal instability.',
    ],
    valueOutput: 'Resistance breakout detected.\nAvoid fresh accumulation at elevated levels.',
    valueWatchouts: [
      'Market Phase: Breakout from Accumulation supports structural re-rating. Breakout during Distribution signals exit liquidity risk.',
      'Capital Participation: Volume expansion should support breakout conviction. Weak Capital Participation signals fragile expansion.',
      'Trend Maturity: Very high ADX indicates mature trend. Falling ADX signals exhaustion risk.',
      'Momentum Thrust: RSI extremes signal overbought risk. Moderate Momentum Thrust supports continuation.',
    ],
  },
  'NEAR_SUPPORT': {
    growthOutput: 'Price testing support zone.\nWait for directional confirmation before initiating.',
    growthWatchouts: [
      'Market Phase: Support tests during Accumulation support bounce probability. Support tests during Distribution increase breakdown risk.',
      'Directional Bias: Price holding above 50 and 100 SMA supports demand defense. Break below signals structural weakness.',
      'Momentum Thrust: RSI stabilization or reversal supports bounce. RSI weakness signals breakdown risk.',
      'Capital Participation: Buying volume near support supports absorption. Rising sell volume signals distribution.',
      'Volatility Regime: Volatility Regime contraction supports base formation. Volatility Regime expansion near support signals instability.',
    ],
    valueOutput: 'Price near support zone.\nAccumulate gradually within the base.',
    valueWatchouts: [
      'Market Phase: Support tests during Accumulation support base formation. Support tests during Mark-Down increase breakdown risk.',
      'Directional Bias: Watch 200 SMA for regime stability. Weak regime reduces accumulation comfort.',
      'Capital Participation: Buying Capital Participation near support supports absorption. Rising sell pressure signals distribution risk.',
      'Trend Maturity: Low ADX supports base-building phase. Rising ADX on declines signals structural weakness.',
      'Momentum Thrust: RSI stabilization supports bounce probability. RSI weakness signals breakdown risk.',
    ],
  },
  'NEAR_RESISTANCE': {
    growthOutput: 'Price testing resistance zone.\nWait for breakout confirmation before initiating or adding.',
    growthWatchouts: [
      'Market Phase: Resistance tests during Mark-Up support breakout probability. Resistance tests during Distribution increase rejection risk.',
      'Directional Bias: Price holding above 50 and 100 SMA supports breakout strength. Break below signals weakening structure.',
      'Momentum Thrust: RSI strength near resistance supports breakout potential. Weak RSI signals rejection risk.',
      'Capital Participation: Buying volume near resistance supports absorption. Low volume signals weak breakout conviction.',
      'Volatility Regime: Volatility Regime contraction near resistance supports breakout build-up. Volatility Regime expansion without breakout signals instability.',
    ],
    valueOutput: 'Price near resistance zone.\nAvoid fresh accumulation at elevated levels.',
    valueWatchouts: [
      'Market Phase: Resistance tests during Distribution increase rejection risk. Resistance tests during Accumulation may signal re-rating preparation.',
      'Capital Participation: Weak Capital Participation near resistance signals fragile demand. Strong Capital Participation supports absorption.',
      'Trend Maturity: Very high ADX indicates mature trend near resistance. Moderate ADX supports continuation.',
      'Volatility Regime: Volatility Regime expansion near resistance signals instability. Volatility Regime contraction supports breakout preparation.',
      'Momentum Thrust: RSI extremes signal overbought risk. Moderate Momentum Thrust supports continuation.',
    ],
  },
  'ABOVE_SUPPORT': {
    growthOutput: 'Price trading moderately above support.\nWait for directional confirmation before initiating or adding.',
    growthWatchouts: [
      'Market Phase: Position above support during Accumulation supports bounce probability. Position above support during Distribution increases breakdown risk.',
      'Directional Bias: Price holding above 50 and 100 SMA supports demand strength. Break below signals structural weakness.',
      'Capital Participation: Buying Capital Participation supports absorption near support. Rising sell pressure signals breakdown risk.',
      'Relative Strength: Relative strength stability supports demand defense. Underperformance signals weak demand.',
      'Volatility Regime: Volatility Regime contraction supports base formation. Volatility Regime expansion on declines signals instability.',
    ],
    valueOutput: 'Price moderately above support.\nAccumulate selectively on approach to support or after stability confirmation.',
    valueWatchouts: [
      'Market Phase: Position above support during Accumulation supports base continuation. Position above support during Mark-Down increases breakdown risk.',
      'Directional Bias: Watch 200 SMA for regime stability. Weak regime reduces accumulation comfort.',
      'Capital Participation: Buying Capital Participation supports absorption near support. Rising sell pressure signals distribution risk.',
      'Trend Maturity: Low ADX supports base-building phase. Rising ADX on declines signals structural weakness.',
      'Volatility Regime: Volatility Regime contraction supports stability. Volatility Regime expansion on declines signals instability.',
    ],
  },
  'BELOW_RESISTANCE': {
    growthOutput: 'Price trading moderately below resistance.\nWait for breakout or rejection confirmation before acting.',
    growthWatchouts: [
      'Market Phase: Position below resistance during Mark-Up supports breakout probability. Position below resistance during Distribution increases rejection risk.',
      'Directional Bias: Price holding above 50 and 100 SMA supports breakout strength. Break below signals weakening structure.',
      'Trend Maturity: Rising ADX supports expansion probability. Low ADX signals range-bound behavior.',
      'Volatility Regime: Volatility Regime contraction supports breakout build-up. Volatility Regime expansion without breakout signals instability.',
    ],
    valueOutput: 'Price moderately below resistance.\nAvoid aggressive accumulation; prefer entries closer to support.',
    valueWatchouts: [
      'Market Phase: Position below resistance during Accumulation supports re-rating preparation. Position below resistance during Distribution increases rejection risk.',
      'Capital Participation: Strong buying Capital Participation supports absorption of supply. Weak Capital Participation signals fragile demand.',
      'Trend Maturity: Moderate ADX supports healthy trend continuation. Very high ADX signals mature trend near resistance.',
      'Volatility Regime: Volatility Regime contraction supports breakout preparation. Volatility Regime expansion signals instability near supply.',
    ],
  },
  'MID_RANGE': {
    growthOutput: 'Price trading in mid-range between support and resistance.\nWait for a directional move toward either level before acting.',
    growthWatchouts: [
      'Market Phase: Mid-range during Accumulation supports base formation. Mid-range during Distribution signals indecision.',
      'Directional Bias: Watch 50 and 100 SMA for directional bias. Price holding above supports demand strength.',
      'Capital Participation: Monitor volume for expansion toward either boundary. Low volume confirms range-bound behavior.',
      'Trend Maturity: Low ADX confirms range-bound conditions. Rising ADX signals a directional breakout is developing.',
    ],
    valueOutput: 'Price in mid-range.\nPrefer accumulation closer to support rather than mid-zone.',
    valueWatchouts: [
      'Market Phase: Mid-range during Accumulation supports gradual base formation. Mid-range during Mark-Down signals continued weakness.',
      'Directional Bias: Watch 200 SMA for regime stability. Weak regime reduces accumulation comfort.',
      'Capital Participation: Buying volume near support supports absorption. Rising sell pressure signals distribution risk.',
      'Trend Maturity: Low ADX supports base-building phase. Rising ADX signals directional expansion ahead.',
    ],
  },
};

const RS_NIFTY_INDICATOR_RULES = {
  'OUTPERFORMING': {
    growthOutput: 'Strong Relative Strength detected.\nInitiate or add positions with trend confirmation.',
    growthWatchouts: [
      'Market Phase: Prefer Mark-Up or Re-Accumulation phases.',
      'Directional Bias: Price should hold above 50 and 100 SMA.',
      'Price Architecture: Breakouts or higher highs should confirm Relative Strength. Failure to sustain breakouts is a warning.',
      'Capital Participation: Volume expansion should support Relative Strength. Weak Capital Participation signals fragile strength.',
    ],
    valueOutput: 'Hold existing positions.\nAvoid fresh buying at strength.',
    valueWatchouts: [
      'Market Phase: Prefer Mark-Up or Re-Accumulation phases. If in Distribution, consider partial exit near resistance.',
      'Directional Bias: Price should hold above 50 and 100 SMA.',
      'Price Architecture: Failure to hold breakout levels or breakdown below support is a warning.',
    ],
  },
  'UNDERPERFORMING': {
    growthOutput: 'Avoid fresh entries.\nMonitor for relative strength improvement.',
    growthWatchouts: [
      'Market Phase: Prefer Accumulation with signs of transition into Mark-Up.',
      'Directional Bias: Watch 200 SMA for regime shift. Alternatively, look for a close above 100 SMA indicating trend improvement.',
      'Capital Participation: CMF should move above zero and continue rising.',
    ],
    valueOutput: 'Accept underperformance.\nFocus on structure and valuation comfort.',
    valueWatchouts: [
      'Market Phase: Ensure accumulation or re-accumulation structure remains intact.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Persistent negative CMF is a warning.',
      'Price Architecture: Failure to hold support while lagging the sector increases downside risk.',
    ],
  },
};

const RS_SECTOR_INDICATOR_RULES = {
  'OUTPERFORMING': {
    growthOutput: 'Relative Strength strength detected.\nInitiate or add positions only if supported by other buckets.',
    growthWatchouts: [
      'Market Phase: Prefer Mark-Up or Re-Accumulation phases.',
      'Directional Bias: Price should hold above 50 and 100 SMA.',
      'Momentum Thrust: RSI should hold above 50.',
      'Price Architecture: Breakouts or higher highs should confirm Relative Strength. Failure to sustain breakouts is a warning.',
    ],
    valueOutput: 'Hold existing positions.\nAvoid chasing strength.',
    valueWatchouts: [
      'Market Phase: Prefer Mark-Up or Re-Accumulation phases. If in Distribution, consider partial exit near resistance.',
      'Directional Bias: Price should hold above 50 and 100 SMA.',
      'Price Architecture: Failure to hold breakout levels or breakdown below support is a warning.',
    ],
  },
  'UNDERPERFORMING': {
    growthOutput: 'Avoid fresh entries.\nMonitor for relative strength improvement.',
    growthWatchouts: [
      'Market Phase: Prefer Accumulation with signs of transition into Mark-Up.',
      'Directional Bias: Watch 200 SMA for regime shift. Alternatively, look for a close above 100 SMA indicating trend improvement.',
      'Capital Participation: CMF should move above zero and continue rising.',
    ],
    valueOutput: 'Accept underperformance.\nFocus on structure and valuation rather than relative strength.',
    valueWatchouts: [
      'Market Phase: Ensure accumulation or re-accumulation structure remains intact.',
      'Directional Bias: Watch 200 SMA for regime stability.',
      'Capital Participation: Persistent negative CMF is a warning.',
      'Price Architecture: Failure to hold support while lagging the sector increases downside risk.',
    ],
  },
};

// ─── Helper Functions ─────────────────────────────────────────────────────────

function _stripLabel(str) {
  if (!str) return str;
  const colonIdx = str.indexOf(': ');
  if (colonIdx === -1) return str;
  return str.slice(colonIdx + 2);
}

function _lookupRule(table, key) {
  if (key == null || !table[key]) {
    return { growthOutput: null, growthWatchouts: [], valueOutput: null, valueWatchouts: [] };
  }
  return table[key];
}

/**
 * Classify price position relative to support and resistance zones.
 * Priority: support zones checked first, then resistance.
 */
function _classifyPriceArchitecture(cmp, support, resistance) {
  if (cmp == null) return null;

  if (support != null && support > 0) {
    const pct = (cmp - support) / support;
    if (pct < -0.02)                    return 'BELOW_SUPPORT';
    if (Math.abs(pct) <= 0.02)          return 'NEAR_SUPPORT';
    if (pct > 0.02 && pct <= 0.10)      return 'ABOVE_SUPPORT';
  }

  if (resistance != null && resistance > 0) {
    const pct = (cmp - resistance) / resistance;
    if (pct > 0.02)                     return 'ABOVE_RESISTANCE';
    if (Math.abs(pct) <= 0.02)          return 'NEAR_RESISTANCE';
    if (pct < -0.02 && pct >= -0.10)    return 'BELOW_RESISTANCE';
  }

  // Price is more than 10% from both support and resistance — mid-range
  if (support != null && support > 0 && resistance != null && resistance > 0) {
    return 'MID_RANGE';
  }
  return null;
}

/**
 * Classify ADX into 9-band lookup key.
 */
function _classifyAdxBand(adx14, adxTrend) {
  if (adx14 == null) return null;
  let band;
  if      (adx14 < 15) band = '0-15';
  else if (adx14 < 25) band = '15-25';
  else if (adx14 < 50) band = '25-50';
  else if (adx14 < 75) band = '50-75';
  else                 band = '75-100';

  if (band === '0-15') return band;
  const dir = (adxTrend === 'RISING' || adxTrend === 'FALLING') ? adxTrend : 'RISING';
  return `${band}-${dir}`;
}

/**
 * Classify RSI into 4-band lookup key.
 */
function _classifyRsiBand(rsi14) {
  if (rsi14 == null) return null;
  if (rsi14 < 30)   return '0-30';
  if (rsi14 < 50)   return '30-50';
  if (rsi14 < 70)   return '50-70';
  return '70-100';
}

/**
 * Generate programmatic directional bias output from the 4 SMA boolean flags.
 */
function _buildDirectionalBiasOutput(d, forValue) {
  const aboveSMA100 = d.sma100 != null ? d.cmp > d.sma100 : null;
  const above20  = d.aboveSMA20;
  const above50  = d.aboveSMA50;
  const above100 = aboveSMA100;
  const above200 = d.aboveSMA200;

  const st  = above20  === true ? 'Above' : above20  === false ? 'Below' : 'N/A';
  const int_ = above50  === true ? 'Above' : above50  === false ? 'Below' : 'N/A';
  const lt  = above100 === true ? 'Above' : above100 === false ? 'Below' : 'N/A';
  const reg = above200 === true ? 'Bullish' : above200 === false ? 'Bearish' : 'N/A';

  const aboveCount = [above20, above50, above100, above200].filter(Boolean).length;

  let action;
  if (!forValue) {
    if (aboveCount === 4) action = 'Price is above all four SMAs. Strong bullish structure. Hold or add positions aligned with trend.';
    else if (aboveCount === 3) action = 'Price is above most SMAs. Bullish structure intact. Prefer entries on pullbacks to key SMAs.';
    else if (aboveCount === 2) action = 'Mixed trend signals. Wait for confirmation above 50 and 100 SMA before initiating.';
    else if (aboveCount === 1) action = 'Bearish structure emerging. Avoid fresh entries; wait for reclaim of 50 SMA.';
    else action = 'Price is below all four SMAs. Strong bearish structure. Avoid fresh entries until regime repairs.';
  } else {
    if (aboveCount === 4) action = 'Price well above all SMAs. Value entry comfort reduced; prefer waiting for pullback to 200 SMA.';
    else if (aboveCount === 3) action = 'Bullish regime intact. Selectively accumulate on meaningful pullbacks toward 100 or 200 SMA.';
    else if (aboveCount === 2) action = 'Mixed structure. Monitor 200 SMA for regime stability before accumulating.';
    else if (aboveCount === 1) action = 'Weak structure. Watch 200 SMA. Accumulate only if valuation and structure strongly support.';
    else action = 'Price below all SMAs. Await base formation near support before considering accumulation.';
  }

  return `Short Term Trend (SMA20): ${st}\nIntermediate Trend (SMA50): ${int_}\nLong Term Trend (SMA100): ${lt}\nRegime (SMA200): ${reg}\n${action}`;
}

/**
 * Build a one-line decision summary from the first sentence of each engine's growthOutput.
 */
function _generateDecisionSummary(engines) {
  const { structureEngine, trendEngine, timingEngine, dominanceEngine } = engines;
  const sources = [
    structureEngine?.marketStructure?.growthOutput,
    structureEngine?.participation?.growthOutput,
    structureEngine?.priceStructure?.growthOutput,
    trendEngine?.trendDirection?.growthOutput,
    trendEngine?.trendQuality?.growthOutput,
    timingEngine?.momentum?.growthOutput,
    timingEngine?.volatility?.growthOutput,
    dominanceEngine?.leadership?.vsNifty?.growthOutput,
    dominanceEngine?.leadership?.vsSector?.growthOutput,
  ];

  return sources
    .filter(Boolean)
    .map((s) => s.split('\n')[0].trim())   // take only first line of each output
    .filter((s, i, arr) => arr.indexOf(s) === i)  // deduplicate
    .join(' | ');
}

/**
 * Flatten all growthWatchouts from every bucket into a deduplicated array.
 */
function _collectAlerts(engines) {
  const { structureEngine, trendEngine, timingEngine, dominanceEngine } = engines;
  const all = [
    ...(structureEngine?.marketStructure?.growthWatchouts || []),
    ...(structureEngine?.participation?.growthWatchouts   || []),
    ...(structureEngine?.priceStructure?.growthWatchouts  || []),
    ...(trendEngine?.trendQuality?.growthWatchouts        || []),
    ...(timingEngine?.momentum?.growthWatchouts           || []),
    ...(timingEngine?.volatility?.growthWatchouts         || []),
    ...(dominanceEngine?.leadership?.vsNifty?.growthWatchouts  || []),
    ...(dominanceEngine?.leadership?.vsSector?.growthWatchouts || []),
  ];
  return [...new Set(all)];
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Compute the full ruleEngine object for the technicals response.
 *
 * @param {object} d          Daily indicators from taIndicators.computeAll()
 * @param {object} row        Watchlist row from Google Sheet
 * @param {object} crsData    { vsNifty: {crsValue, prevCrsValue}|null, vsSector: {sectorTicker, crsValue, prevCrsValue}|null }
 * @param {string|null} fallbackPhase  Price-derived Wyckoff phase (lib/wyckoff.js), already
 *                                     mapped to IndicatorRules.WYCKOFF. Used only when the
 *                                     sheet has no PHASE for this ticker — the hand-maintained
 *                                     sheet value still wins where it exists.
 * @returns {object}          ruleEngine payload
 */
function computeRuleEngine(d, row, crsData, fallbackPhase = null) {
  const cmp        = d.cmp;
  const support    = parseFloat(row['SUPPORT'])    || null;
  const resistance = parseFloat(row['RESISTANCE']) || null;
  const phase      = (row['PHASE'] || '').toUpperCase().trim() || (fallbackPhase || '');

  // ── Structure Engine ───────────────────────────────────────────────────────

  // Market Structure bucket (Wyckoff Phase indicator)
  const wyckoffRule = _lookupRule(WYCKOFF_INDICATOR_RULES, phase);
  const marketStructure = {
    wyckoffPhase:    phase || null,
    growthOutput:    wyckoffRule.growthOutput,
    growthWatchouts: wyckoffRule.growthWatchouts,
    valueOutput:     wyckoffRule.valueOutput,
    valueWatchouts:  wyckoffRule.valueWatchouts,
  };

  // Participation bucket — Volume indicator (vs 30-day avg)
  const volSignal = d.volumeVsAvg30Signal || null;
  const volRule   = _lookupRule(VOLUME_INDICATOR_RULES, volSignal);

  // Participation bucket — CMF indicator
  const cmfValue  = d.cmf20 != null ? Math.round(d.cmf20 * 10000) / 10000 : null;
  const cmfKey    = cmfValue == null ? null : (cmfValue > 0 ? 'POSITIVE' : 'NEGATIVE');
  const cmfRule   = _lookupRule(CMF_INDICATOR_RULES, cmfKey);

  // Merge vol + CMF: use CMF as primary output, merge watchouts
  const participation = {
    volumeSignal:    volSignal,
    cmfSignal:       cmfKey,
    cmf:             cmfValue,
    growthOutput:    cmfRule.growthOutput || volRule.growthOutput,
    growthWatchouts: [...new Set([...volRule.growthWatchouts, ...cmfRule.growthWatchouts])],
    valueOutput:     cmfRule.valueOutput  || volRule.valueOutput,
    valueWatchouts:  [...new Set([...volRule.valueWatchouts,  ...cmfRule.valueWatchouts])],
  };

  // Price Structure bucket (Support & Resistance indicator)
  const priceZone = _classifyPriceArchitecture(cmp, support, resistance);
  const priceRule = _lookupRule(PRICE_ARCH_INDICATOR_RULES, priceZone);
  const priceStructure = {
    zone:            priceZone,
    growthOutput:    priceRule.growthOutput,
    growthWatchouts: priceRule.growthWatchouts,
    valueOutput:     priceRule.valueOutput,
    valueWatchouts:  priceRule.valueWatchouts,
  };

  const structureEngine = { marketStructure, participation, priceStructure };

  // ── Trend Engine ───────────────────────────────────────────────────────────

  // Trend Direction bucket (SMA indicator — programmatic)
  const aboveSMA100 = d.sma100 != null ? d.cmp > d.sma100 : null;
  const trendDirection = {
    priceVsSMA20:  d.aboveSMA20  === true ? 'ABOVE' : d.aboveSMA20  === false ? 'BELOW' : null,
    priceVsSMA50:  d.aboveSMA50  === true ? 'ABOVE' : d.aboveSMA50  === false ? 'BELOW' : null,
    priceVsSMA100: aboveSMA100   === true ? 'ABOVE' : aboveSMA100   === false ? 'BELOW' : null,
    priceVsSMA200: d.aboveSMA200 === true ? 'ABOVE' : d.aboveSMA200 === false ? 'BELOW' : null,
    growthOutput:  _buildDirectionalBiasOutput(d, false),
    valueOutput:   _buildDirectionalBiasOutput(d, true),
  };

  // Trend Quality bucket (ADX indicator)
  const adxBandKey = _classifyAdxBand(d.adx14, d.adxTrend);
  const adxRule    = _lookupRule(ADX_INDICATOR_RULES, adxBandKey);
  const adxBandLabel = adxBandKey
    ? adxBandKey.replace('-RISING', '').replace('-FALLING', '')
    : null;
  const adxCondition = adxBandLabel && d.adxTrend && d.adxTrend !== 'FLAT'
    ? `${adxBandLabel} & ${d.adxTrend.charAt(0) + d.adxTrend.slice(1).toLowerCase()}`
    : adxBandLabel;

  const trendQuality = {
    adx:             d.adx14 != null ? Math.round(d.adx14 * 100) / 100 : null,
    adxTrend:        d.adxTrend || null,
    adxBand:         adxBandLabel,
    condition:       adxCondition,
    growthOutput:    adxRule.growthOutput,
    growthWatchouts: adxRule.growthWatchouts,
    valueOutput:     adxRule.valueOutput,
    valueWatchouts:  adxRule.valueWatchouts,
  };

  const trendEngine = { trendDirection, trendQuality };

  // ── Timing Engine ──────────────────────────────────────────────────────────

  // Momentum bucket (RSI indicator)
  const rsiBand = _classifyRsiBand(d.rsi14);
  const rsiRule = _lookupRule(RSI_INDICATOR_RULES, rsiBand);
  const momentum = {
    rsi:             d.rsi14 != null ? Math.round(d.rsi14 * 100) / 100 : null,
    rsiZone:         rsiBand,
    growthOutput:    rsiRule.growthOutput,
    growthWatchouts: rsiRule.growthWatchouts,
    valueOutput:     rsiRule.valueOutput,
    valueWatchouts:  rsiRule.valueWatchouts,
  };

  // Volatility bucket (BB Width indicator)
  const bbWidth     = d.bbWidth     != null ? Math.round(d.bbWidth     * 10000) / 10000 : null;
  const prevBbWidth = d.prevBbWidth != null ? Math.round(d.prevBbWidth * 10000) / 10000 : null;
  const bbExpanding = (bbWidth != null && prevBbWidth != null) ? bbWidth > prevBbWidth : null;
  const bbCondKey   = bbExpanding == null ? null : (bbExpanding ? 'EXPANDING' : 'CONTRACTING');
  const bbRule      = _lookupRule(BB_INDICATOR_RULES, bbCondKey);
  const volatility = {
    bbWidth,
    prevBbWidth,
    expanding:       bbExpanding,
    condition:       bbCondKey,
    growthOutput:    bbRule.growthOutput,
    growthWatchouts: bbRule.growthWatchouts,
    valueOutput:     bbRule.valueOutput,
    valueWatchouts:  bbRule.valueWatchouts,
  };

  const timingEngine = { momentum, volatility };

  // ── Dominance Engine ───────────────────────────────────────────────────────

  const niftyCrs    = crsData?.vsNifty  ?? null;
  const sectorCrs   = crsData?.vsSector ?? null;

  const niftySignal = niftyCrs?.crsValue != null && niftyCrs?.prevCrsValue != null
    ? (niftyCrs.crsValue > niftyCrs.prevCrsValue ? 'OUTPERFORMING' : 'UNDERPERFORMING')
    : null;
  const niftyRule = _lookupRule(RS_NIFTY_INDICATOR_RULES, niftySignal);

  const sectorSignal = sectorCrs?.crsValue != null && sectorCrs?.prevCrsValue != null
    ? (sectorCrs.crsValue > sectorCrs.prevCrsValue ? 'OUTPERFORMING' : 'UNDERPERFORMING')
    : null;
  const sectorRule = _lookupRule(RS_SECTOR_INDICATOR_RULES, sectorSignal);

  // Third leg (sector vs NIFTY). No canned rule text — the growth/value output tables cover
  // stock-relative legs only; this leg exists so Module 5's 3-way table can be matched.
  const sectorNiftyCrs = crsData?.vsSectorNifty ?? null;
  const sectorNiftySignal = sectorNiftyCrs?.crsValue != null && sectorNiftyCrs?.prevCrsValue != null
    ? (sectorNiftyCrs.crsValue > sectorNiftyCrs.prevCrsValue ? 'OUTPERFORMING' : 'UNDERPERFORMING')
    : null;

  const dominanceEngine = {
    leadership: {
      vsNifty: {
        crsValue:        niftyCrs?.crsValue     ?? null,
        prevCrsValue:    niftyCrs?.prevCrsValue ?? null,
        signal:          niftySignal,
        growthOutput:    niftyRule.growthOutput,
        growthWatchouts: niftyRule.growthWatchouts,
        valueOutput:     niftyRule.valueOutput,
        valueWatchouts:  niftyRule.valueWatchouts,
      },
      vsSector: {
        sectorTicker:    sectorCrs?.sectorTicker ?? null,
        crsValue:        sectorCrs?.crsValue     ?? null,
        prevCrsValue:    sectorCrs?.prevCrsValue ?? null,
        signal:          sectorSignal,
        growthOutput:    sectorRule.growthOutput,
        growthWatchouts: sectorRule.growthWatchouts,
        valueOutput:     sectorRule.valueOutput,
        valueWatchouts:  sectorRule.valueWatchouts,
      },
      vsSectorNifty: {
        sectorTicker:    sectorNiftyCrs?.sectorTicker ?? null,
        crsValue:        sectorNiftyCrs?.crsValue     ?? null,
        prevCrsValue:    sectorNiftyCrs?.prevCrsValue ?? null,
        signal:          sectorNiftySignal,
      },
    },
  };

  // ── Decision Context ───────────────────────────────────────────────────────

  const allEngines = { structureEngine, trendEngine, timingEngine, dominanceEngine };

  // SMA above-count drives marketBias and overallCondition labels
  const smaAboveCount = [d.aboveSMA20, d.aboveSMA50, aboveSMA100, d.aboveSMA200].filter(Boolean).length;
  const _BIAS_MAP = ['Strong bearish bias', 'Bearish bias', 'Neutral bias', 'Mild bullish bias', 'Bullish bias'];
  const _COND_MAP = ['Risk-off', 'Risk-off', 'Neutral', 'Risk-on', 'Risk-on'];

  // Compute alerts first (needs growthWatchouts arrays intact)
  const decisionContext = {
    summary:          _generateDecisionSummary(allEngines),
    alerts:           _collectAlerts(allEngines),
    marketBias:       _BIAS_MAP[smaAboveCount],
    overallCondition: _COND_MAP[smaAboveCount],
  };

  // ── Strip label prefix from watchout arrays ────────────────────────────────
  const buckets = [
    structureEngine.marketStructure,
    structureEngine.participation,
    structureEngine.priceStructure,
    trendEngine.trendQuality,
    timingEngine.momentum,
    timingEngine.volatility,
    dominanceEngine.leadership.vsNifty,
    dominanceEngine.leadership.vsSector,
  ];
  for (const bucket of buckets) {
    if (!bucket) continue;
    bucket.growthWatchout = (bucket.growthWatchouts || []).map(_stripLabel).join(' ') || null;
    bucket.valueWatchout  = (bucket.valueWatchouts  || []).map(_stripLabel).join(' ') || null;
    delete bucket.growthWatchouts;
    delete bucket.valueWatchouts;
  }

  return { structureEngine, trendEngine, timingEngine, dominanceEngine, decisionContext };
}

module.exports = {
  computeRuleEngine,
  // Exported for testing
  WYCKOFF_INDICATOR_RULES,
  RSI_INDICATOR_RULES,
  ADX_INDICATOR_RULES,
  BB_INDICATOR_RULES,
  VOLUME_INDICATOR_RULES,
  CMF_INDICATOR_RULES,
  PRICE_ARCH_INDICATOR_RULES,
  RS_NIFTY_INDICATOR_RULES,
  RS_SECTOR_INDICATOR_RULES,
};
