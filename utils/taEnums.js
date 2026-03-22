'use strict';

// ─── Layer 1: Buckets ─────────────────────────────────────────────────────────
// High-level concept categories. Each bucket answers one key question about
// price behaviour. Buckets do NOT calculate — they classify.

const Buckets = Object.freeze({
  MARKET_STRUCTURE: 'MARKET_STRUCTURE',  // Where is the stock in the cycle?
  TREND_DIRECTION:  'TREND_DIRECTION',   // Where is price headed?
  LEADERSHIP:       'LEADERSHIP',        // Is the stock leading or lagging?
  TREND_QUALITY:    'TREND_QUALITY',     // Is the trend early, strong, or mature?
  MOMENTUM:         'MOMENTUM',          // Is momentum weak, strong, or overheated?
  VOLATILITY:       'VOLATILITY',        // Are we in contraction or expansion?
  PARTICIPATION:    'PARTICIPATION',     // Is big money entering or already placed?
  PRICE_STRUCTURE:  'PRICE_STRUCTURE',   // Where are key decision levels?
});

// ─── Layer 2: Indicators ──────────────────────────────────────────────────────
// Measurement tools mapped to each bucket.

const Indicators = Object.freeze({
  WYCKOFF_PHASE:                 'WYCKOFF_PHASE',                 // → MARKET_STRUCTURE
  SMA:                           'SMA',                           // → TREND_DIRECTION (20, 50, 100, 200)
  COMPARATIVE_RELATIVE_STRENGTH: 'COMPARATIVE_RELATIVE_STRENGTH', // → LEADERSHIP (vs Nifty, vs Sector)
  ADX:                           'ADX',                           // → TREND_QUALITY (14)
  RSI:                           'RSI',                           // → MOMENTUM (14)
  BB_WIDTH:                      'BB_WIDTH',                      // → VOLATILITY (20, 2)
  AVG_VOLUME:                    'AVG_VOLUME',                    // → PARTICIPATION (30-day avg)
  CMF:                           'CMF',                           // → PARTICIPATION (20)
  SUPPORT_RESISTANCE:            'SUPPORT_RESISTANCE',            // → PRICE_STRUCTURE
});

// ─── Layer 3: Indicator Rules ─────────────────────────────────────────────────
// Predefined rule keys that convert numerical values into categorical states.
// String values must match the lookup keys in taRuleEngine.js rule tables.

const IndicatorRules = Object.freeze({

  // WYCKOFF_PHASE → MARKET_STRUCTURE bucket
  WYCKOFF: Object.freeze({
    ACCUMULATION:    'ACCUMULATION',
    MARK_UP:         'MARK-UP',
    RE_ACCUMULATION: 'RE-ACCUMULATION',
    DISTRIBUTION:    'DISTRIBUTION',
    MARK_DOWN:       'MARK-DOWN',
    RE_DISTRIBUTION: 'RE-DISTRIBUTION',
  }),

  // RSI → MOMENTUM bucket
  RSI: Object.freeze({
    OVERSOLD:   '0-30',
    WEAK:       '30-50',
    STRONG:     '50-70',
    OVERBOUGHT: '70-100',
  }),

  // ADX → TREND_QUALITY bucket
  ADX: Object.freeze({
    WEAK:               '0-15',
    MILD_RISING:        '15-25-RISING',
    MILD_FALLING:       '15-25-FALLING',
    STRONG_RISING:      '25-50-RISING',
    STRONG_FALLING:     '25-50-FALLING',
    VERY_STRONG_RISING: '50-75-RISING',
    VERY_STRONG_FALLING:'50-75-FALLING',
    EXTREME_RISING:     '75-100-RISING',
    EXTREME_FALLING:    '75-100-FALLING',
  }),

  // BB_WIDTH → VOLATILITY bucket
  BB: Object.freeze({
    EXPANDING:   'EXPANDING',
    CONTRACTING: 'CONTRACTING',
  }),

  // AVG_VOLUME → PARTICIPATION bucket
  VOLUME: Object.freeze({
    ABOVE_AVERAGE: 'ABOVE_AVERAGE',
    BELOW_AVERAGE: 'BELOW_AVERAGE',
  }),

  // CMF → PARTICIPATION bucket
  CMF: Object.freeze({
    POSITIVE: 'POSITIVE',
    NEGATIVE: 'NEGATIVE',
  }),

  // SUPPORT_RESISTANCE → PRICE_STRUCTURE bucket
  PRICE: Object.freeze({
    BELOW_SUPPORT:    'BELOW_SUPPORT',
    NEAR_SUPPORT:     'NEAR_SUPPORT',
    ABOVE_SUPPORT:    'ABOVE_SUPPORT',
    NEAR_RESISTANCE:  'NEAR_RESISTANCE',
    BELOW_RESISTANCE: 'BELOW_RESISTANCE',
    ABOVE_RESISTANCE: 'ABOVE_RESISTANCE',
    MID_RANGE:        'MID_RANGE',
  }),

  // COMPARATIVE_RELATIVE_STRENGTH → LEADERSHIP bucket
  RS: Object.freeze({
    OUTPERFORMING:  'OUTPERFORMING',
    UNDERPERFORMING: 'UNDERPERFORMING',
  }),

});

module.exports = { Buckets, Indicators, IndicatorRules };
