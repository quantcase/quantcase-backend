'use strict';

/**
 * Constants, vocabulary contracts, and lookup tables for the
 * deterministic Technical Analysis Scoring Engine.
 */

const INDICATOR_IDS = [
  'market_structure',
  'capital_participation',
  'price_architecture',
  'trend_direction',
  'trend_quality',
  'momentum',
  'volatility',
  'relative_strength',
];

const INDICATOR_META = {
  market_structure:      { id: 'market_structure',      name: 'Market Structure',      tab: 'Structure' },
  capital_participation: { id: 'capital_participation', name: 'Capital Participation', tab: 'Structure' },
  price_architecture:    { id: 'price_architecture',    name: 'Price Architecture',    tab: 'Structure' },
  trend_direction:       { id: 'trend_direction',       name: 'Trend Direction',       tab: 'Trend' },
  trend_quality:         { id: 'trend_quality',         name: 'Trend Quality',         tab: 'Trend' },
  momentum:              { id: 'momentum',              name: 'Momentum',              tab: 'Timing' },
  volatility:            { id: 'volatility',            name: 'Volatility',            tab: 'Timing' },
  relative_strength:     { id: 'relative_strength',     name: 'Relative Strength',     tab: 'Relative Strength' },
};

const LEVEL_LABELS = {
  immediate:  'Short term support',
  structural: 'Key support',
  regime:     'Long term average',
};

const BANDS = [
  { min: 85, max: 100, grade: 'A+', label: 'Leader',     conviction: 'Very High', decision: 'Favorable – High Conviction', topMin: 93, topMax: 100, botMin: 85, botMax: 92 },
  { min: 70, max: 84,  grade: 'A',  label: 'Strong',     conviction: 'High',      decision: 'Favorable Setup',            topMin: 78, topMax: 84,  botMin: 70, botMax: 77 },
  { min: 55, max: 69,  grade: 'B',  label: 'Developing', conviction: 'Medium',    decision: 'Neutral – Monitor',           topMin: 63, topMax: 69,  botMin: 55, botMax: 62 },
  { min: 40, max: 54,  grade: 'C',  label: 'Weak',       conviction: 'Low',       decision: 'Caution – Monitor',           topMin: 48, topMax: 54,  botMin: 40, botMax: 47 },
  { min: 0,  max: 39,  grade: 'D',  label: 'Breakdown',  conviction: 'Very Low',  decision: 'Unfavorable Setup',           topMin: 33, topMax: 39,  botMin: 0,  botMax: 32 },
];

/** Candidate tags by band, tier, and direction flag */
const CANDIDATE_TAGS = {
  '85-100_Top_FlatOrRising': [
    'Everything Aligned, Strong Buy',
    'All Signals Firing, High Conviction',
    'Full Strength, Right Time To Buy',
  ],
  '85-100_Bottom_FlatOrRising': [
    'Strong Setup, Nearly Perfect',
    'Uptrend Solid, Stay Invested',
    'Good Strength, Minor Gaps Only',
  ],
  '85-100_Tier_Falling': [
    'Strong But Slipping, Protect Gains',
    'Signals Fading, Trail Your Stops',
    'Still Bullish, But Watch Closely',
  ],
  '85-100_Band_Rising': [
    'Turned Very Strong, Right Time',
    'Big Improvement, Conviction Building',
    'Crossed Into High Conviction Zone',
  ],

  '70-84_Top_FlatOrRising': [
    'Uptrend Intact, Building Strength',
    'Good Setup, Buying Energy Present',
    'Trend Strong, Conditions Improving',
  ],
  '70-84_Bottom_Flat': [
    'Uptrend Good, Not Fully Aligned',
    'Positive, But Room To Improve',
    'Trend Intact, Watch For Confirmation',
  ],
  '70-84_Tier_Rising': [
    'Improving Fast, Confidence Building',
    'Getting Stronger, Good Signs Ahead',
    'Trend Gaining Edge, Stay Invested',
  ],
  '70-84_Tier_Falling': [
    'Uptrend Holding, But Losing Edge',
    'Good Setup Fading, Stay Alert',
    'Trend Intact, Tighten Your Stops',
  ],
  '70-84_Band_Falling': [
    'Strength Fading, Reduce Exposure',
    'Slipping From Peak, Protect Profits',
    'Was Strong, Now Needs Watching',
  ],

  '55-69_Top_Flat': [
    'Setup Forming, Wait For Trigger',
    'Potential Building, Not Ready Yet',
    'Early Signs, Needs Confirmation',
  ],
  '55-69_Tier_Rising': [
    'Turning Around, Watch For Entry',
    'Getting Interesting, Prepare Now',
    'Signs Improving, Almost Ready',
  ],
  '55-69_Bottom_Flat': [
    'Mixed Picture, Proceed With Caution',
    'More Clarity Needed Before Entry',
    'Signals Divided, Wait And Watch',
  ],
  '55-69_Band_Rising': [
    'Recovery Underway, Watch Closely',
    'Improving From Weakness, Take Note',
    'Turning Corner, Not There Yet',
  ],
  '55-69_Tier_Falling': [
    'Setup Weakening, Step Back Now',
    'Was Promising, Now Less Clear',
    'Caution Rising, No Entry Yet',
  ],
  '55-69_Band_Falling': [
    'Uptrend Stalling, Reduce Or Wait',
    'Lost Bullish Edge, Reassess Now',
    'Trend Weakening, Not Right Time',
  ],

  '40-54_Top_Flat': [
    'Weak Setup, High Risk Entry',
    'Conditions Soft, Avoid Fresh Buying',
    'Not The Right Time Yet',
  ],
  '40-54_Tier_Rising': [
    'Slight Improvement, Still Cautious',
    'Recovering Slowly, Too Early Yet',
    'Weak But Showing Some Life',
  ],
  '40-54_Bottom_Flat': [
    'Deteriorating, Stay On Sidelines',
    'Risk Rising, Reduce Exposure',
    'Weak And Getting Weaker',
  ],
  '40-54_Band_Rising': [
    'Off The Lows, Still Risky',
    'Early Recovery Signs, Stay Cautious',
    'Improving But Still Avoid Entry',
  ],
  '40-54_Tier_Falling': [
    'Getting Worse, Exit If Holding',
    'Risk Increasing, No Reason To Stay',
    'Avoid, Conditions Still Declining',
  ],
  '40-54_Band_Falling': [
    'Turned Weak, Exit Partial Position',
    'Setup Failed, Reassess Completely',
    'Clear Warning, Protect Capital Now',
  ],

  'below40_Top_FlatOrRising': [
    'Avoid, Structure Breaking Down',
    'Selling Pressure Dominant, Stay Out',
    'Bear Phase, No Entry Signal',
  ],
  'below40_Tier_Rising': [
    'Slightly Less Weak, Still Avoid',
    'Small Recovery, Not Enough Yet',
    'Bear Phase Easing, Watch Only',
  ],
  'below40_Bottom_Flat': [
    'Avoid, Everything Points Down',
    'High Risk, No Reason To Hold',
    'Full Bear, Exit Or Stay Away',
  ],
  'below40_Tier_Falling': [
    'Deep Bear, Exit Immediately',
    'Everything Failing, High Risk',
    'No Floor In Sight, Avoid',
  ],
  'below40_Band_Falling': [
    'Crossed Into Bear Territory, Exit',
    'Support Gone, Risk Is Very High',
    'Bear Phase Confirmed, Stay Away',
  ],
};

module.exports = {
  INDICATOR_IDS,
  INDICATOR_META,
  LEVEL_LABELS,
  BANDS,
  CANDIDATE_TAGS,
};
