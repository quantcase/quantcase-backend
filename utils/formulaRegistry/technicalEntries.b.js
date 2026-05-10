'use strict';

// Technical indicator entries: Volatility, Trend/Market Structure, Volume (21 entries).

module.exports = [

  // ── Volatility (daily only) ─────────────────────────────────────────────────

  { id: 'TA_ATR_14',       taKey: 'atr14',          taAppliesTo: ['daily'], name: 'ATR 14',                      unit: '₹',     formula: "Wilder's ATR(14)" },
  { id: 'TA_ATR_PCT',      taKey: 'atrPercent',     taAppliesTo: ['daily'], name: 'ATR %',                       unit: '%',     formula: 'ATR14 / CMP × 100' },
  { id: 'TA_BB_UPPER',     taKey: 'bbUpper',        taAppliesTo: ['daily'], name: 'Bollinger Upper Band',        unit: '₹',     formula: 'SMA(20) + 2 × σ(20)' },
  { id: 'TA_BB_MIDDLE',    taKey: 'bbMiddle',       taAppliesTo: ['daily'], name: 'Bollinger Middle Band',       unit: '₹',     formula: 'SMA(20)' },
  { id: 'TA_BB_LOWER',     taKey: 'bbLower',        taAppliesTo: ['daily'], name: 'Bollinger Lower Band',        unit: '₹',     formula: 'SMA(20) − 2 × σ(20)' },
  { id: 'TA_BB_WIDTH',     taKey: 'bbWidth',        taAppliesTo: ['daily'], name: 'Bollinger Band Width',        unit: 'ratio', formula: '(Upper − Lower) / Middle' },
  { id: 'TA_BB_SQUEEZE',   taKey: 'bbSqueeze',      taAppliesTo: ['daily'], name: 'Bollinger Squeeze',           unit: 'bool',  formula: 'BB Width < 0.10' },
  { id: 'TA_BB_WIDTH_PREV',taKey: 'prevBbWidth',    taAppliesTo: ['daily'], name: 'Bollinger Band Width (prev bar)', unit: 'ratio', formula: 'BB Width of second-to-last bar' },

  // ── Trend / Market Structure ─────────────────────────────────────────────────

  {
    id: 'TA_ADX_14', taKey: 'adx14', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'ADX 14', unit: 'osc', formula: "Wilder's ADX(14)",
  },
  {
    id: 'TA_ADX_TREND', taKey: 'adxTrend', taAppliesTo: ['daily'],
    name: 'ADX Trend', unit: 'label', formula: 'RISING if ADX↑>0.3 · FALLING if ADX↓>0.3 · FLAT otherwise',
  },
  {
    id: 'TA_HIGHER_HIGHS', taKey: 'higherHighs', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Higher Highs', unit: 'bool', formula: 'max(highs, last 20 bars) > max(highs, prior 20 bars)',
  },
  {
    id: 'TA_HIGHER_LOWS', taKey: 'higherLows', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Higher Lows', unit: 'bool', formula: 'min(lows, last 20 bars) > min(lows, prior 20 bars)',
  },

  // ── Volume ──────────────────────────────────────────────────────────────────

  {
    id: 'TA_AVG_VOL_20', taKey: 'avgVolume20', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Average Volume 20', unit: 'shares', formula: 'avg(volume, last 20 bars, excluding zeros)',
  },
  {
    id: 'TA_AVG_VOL_30', taKey: 'avgVolume30', taAppliesTo: ['daily'],
    name: 'Average Volume 30', unit: 'shares', formula: 'avg(volume, last 30 bars, excluding zeros)',
  },
  {
    id: 'TA_VOL_RATIO', taKey: 'volumeRatio', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Volume Ratio', unit: 'ratio', formula: 'current volume / AvgVolume20',
  },
  {
    id: 'TA_VOL_VS_AVG30', taKey: 'volumeVsAvg30Signal', taAppliesTo: ['daily'],
    name: 'Volume vs 30-bar Average', unit: 'label', formula: 'ABOVE_AVERAGE if volume > AvgVolume30 else BELOW_AVERAGE',
  },
  {
    id: 'TA_VOL_TREND', taKey: 'volumeTrend', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Volume Trend', unit: 'label', formula: 'INCREASING / DECREASING / FLAT — avg(last 5) vs avg(prior 15)',
  },
  {
    id: 'TA_VOL_BREAKOUT', taKey: 'volumeBreakout', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Volume Breakout', unit: 'bool', formula: 'VolumeRatio > 1.5',
  },
  {
    id: 'TA_ACCUMULATION', taKey: 'accumulation', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Accumulation', unit: 'bool', formula: 'price up AND volume breakout',
  },
  {
    id: 'TA_DISTRIBUTION', taKey: 'distribution', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'Distribution', unit: 'bool', formula: 'price down AND volume breakout',
  },
  {
    id: 'TA_CMF_20', taKey: 'cmf20', taAppliesTo: ['daily'],
    name: 'Chaikin Money Flow 20', unit: 'osc',
    formula: 'CMF(20) = Σ(MFV, 20) / Σ(volume, 20)',
    desc:    'Positive → buying pressure; negative → selling pressure',
  },
];
