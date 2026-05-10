'use strict';

// Technical indicator entries: Price, Moving Averages, Crossovers, Momentum (32 entries).

module.exports = [

  // ── Price ───────────────────────────────────────────────────────────────────

  { id: 'TA_CMP',          taKey: 'cmp',              taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'Current Market Price',       unit: '₹',      formula: 'live quote price; falls back to last bar close' },
  { id: 'TA_PREV_CLOSE',   taKey: 'prevClose',        taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'Previous Close',             unit: '₹',      formula: 'close of the bar before the last bar' },
  { id: 'TA_VOLUME',       taKey: 'volume',           taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'Volume',                     unit: 'shares', formula: 'last bar volume' },
  { id: 'TA_OPEN',         taKey: 'open',             taAppliesTo: ['daily'],                      name: 'Open',                       unit: '₹',      formula: 'last bar open price' },
  { id: 'TA_HIGH',         taKey: 'high',             taAppliesTo: ['daily'],                      name: "Day's High",                 unit: '₹',      formula: 'last bar high price' },
  { id: 'TA_LOW',          taKey: 'low',              taAppliesTo: ['daily'],                      name: "Day's Low",                  unit: '₹',      formula: 'last bar low price' },
  { id: 'TA_HIGH_52W',     taKey: 'high52w',          taAppliesTo: ['daily'],                      name: '52-Week High',               unit: '₹',      formula: 'quote.fiftyTwoWeekHigh ?? max(highs, 1y bars)' },
  { id: 'TA_LOW_52W',      taKey: 'low52w',           taAppliesTo: ['daily'],                      name: '52-Week Low',                unit: '₹',      formula: 'quote.fiftyTwoWeekLow ?? min(lows, 1y bars)' },
  { id: 'TA_DIST_52W_HIGH',taKey: 'distFrom52wHigh',  taAppliesTo: ['daily'],                      name: 'Distance from 52W High',     unit: '%',      formula: '(CMP − High52W) / High52W × 100' },
  { id: 'TA_DIST_52W_LOW', taKey: 'distFrom52wLow',   taAppliesTo: ['daily'],                      name: 'Distance from 52W Low',      unit: '%',      formula: '(CMP − Low52W) / Low52W × 100' },

  // ── Moving Averages ─────────────────────────────────────────────────────────

  { id: 'TA_SMA_20',       taKey: 'sma20',            taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'SMA 20',                     unit: '₹',      formula: 'SMA(close, 20)' },
  { id: 'TA_SMA_50',       taKey: 'sma50',            taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'SMA 50',                     unit: '₹',      formula: 'SMA(close, 50)' },
  { id: 'TA_SMA_100',      taKey: 'sma100',           taAppliesTo: ['daily'],                      name: 'SMA 100',                    unit: '₹',      formula: 'SMA(close, 100)' },
  { id: 'TA_SMA_200',      taKey: 'sma200',           taAppliesTo: ['daily'],                      name: 'SMA 200',                    unit: '₹',      formula: 'SMA(close, 200)' },
  { id: 'TA_EMA_20',       taKey: 'ema20',            taAppliesTo: ['daily'],                      name: 'EMA 20',                     unit: '₹',      formula: 'EMA(close, 20)' },
  { id: 'TA_EMA_50',       taKey: 'ema50',            taAppliesTo: ['daily'],                      name: 'EMA 50',                     unit: '₹',      formula: 'EMA(close, 50)' },
  { id: 'TA_ABOVE_SMA20',  taKey: 'aboveSMA20',       taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'Price Above SMA 20',         unit: 'bool',   formula: 'CMP > SMA20' },
  { id: 'TA_ABOVE_SMA50',  taKey: 'aboveSMA50',       taAppliesTo: ['daily', 'weekly', 'monthly'], name: 'Price Above SMA 50',         unit: 'bool',   formula: 'CMP > SMA50' },
  { id: 'TA_ABOVE_SMA200', taKey: 'aboveSMA200',      taAppliesTo: ['daily'],                      name: 'Price Above SMA 200',        unit: 'bool',   formula: 'CMP > SMA200' },

  // ── Crossovers (daily only) ─────────────────────────────────────────────────

  { id: 'TA_GOLDEN_CROSS',       taKey: 'goldenCross',       taAppliesTo: ['daily'], name: 'Golden Cross',        unit: 'bool', formula: 'SMA50 crossed above SMA200 within last 60 bars' },
  { id: 'TA_DEATH_CROSS',        taKey: 'deathCross',        taAppliesTo: ['daily'], name: 'Death Cross',         unit: 'bool', formula: 'SMA50 crossed below SMA200 within last 60 bars' },
  { id: 'TA_LAST_CROSSOVER_DATE',taKey: 'lastCrossoverDate', taAppliesTo: ['daily'], name: 'Last Crossover Date', unit: 'date', formula: 'date of most recent golden or death cross' },

  // ── Momentum ────────────────────────────────────────────────────────────────

  {
    id: 'TA_RSI_14', taKey: 'rsi14', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'RSI 14', unit: 'osc', formula: "Wilder's RSI(14)",
  },
  {
    id: 'TA_RSI_ZONE', taKey: 'rsiZone', taAppliesTo: ['daily', 'weekly', 'monthly'],
    name: 'RSI Zone', unit: 'label', formula: 'OVERBOUGHT if RSI≥70 · OVERSOLD if RSI≤30 · NEUTRAL otherwise',
  },
  {
    id: 'TA_RSI_TREND', taKey: 'rsiTrend', taAppliesTo: ['daily'],
    name: 'RSI Trend', unit: 'label', formula: 'RISING / FALLING / FLAT — compare last two RSI values (±0.5 threshold)',
  },
  {
    id: 'TA_MACD', taKey: 'macdValue', taAppliesTo: ['daily'],
    name: 'MACD Line', unit: '₹', formula: 'EMA(12) − EMA(26)',
  },
  {
    id: 'TA_MACD_SIGNAL', taKey: 'macdSignal', taAppliesTo: ['daily'],
    name: 'MACD Signal', unit: '₹', formula: 'EMA(MACD, 9)',
  },
  {
    id: 'TA_MACD_HIST', taKey: 'macdHistogram', taAppliesTo: ['daily'],
    name: 'MACD Histogram', unit: '₹', formula: 'MACD − Signal',
  },
  {
    id: 'TA_MACD_CROSSOVER', taKey: 'macdCrossover', taAppliesTo: ['daily'],
    name: 'MACD Crossover', unit: 'label', formula: 'BULLISH / BEARISH / ABOVE / BELOW / NONE',
  },
  {
    id: 'TA_STOCH_K', taKey: 'stochK', taAppliesTo: ['daily'],
    name: 'Stochastic %K', unit: 'osc', formula: 'Stochastic %K(14)',
  },
  {
    id: 'TA_STOCH_D', taKey: 'stochD', taAppliesTo: ['daily'],
    name: 'Stochastic %D', unit: 'osc', formula: 'SMA(%K, 3)',
  },
  {
    id: 'TA_STOCH_SIGNAL', taKey: 'stochSignal', taAppliesTo: ['daily'],
    name: 'Stochastic Signal', unit: 'label', formula: 'BUY / OVERBOUGHT / OVERSOLD / NEUTRAL',
  },
];
