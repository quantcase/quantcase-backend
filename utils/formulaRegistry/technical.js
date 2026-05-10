'use strict';

const taIndicators = require('../taIndicators');

// ── Technical Indicator Registry ──────────────────────────────────────────────
//
// Each entry describes one technical indicator:
//   taKey       — key name in taIndicators.computeAll() output flat objects
//   taAppliesTo — timeframes this indicator is computed for
//   name / unit / desc / formula — metadata for admin catalogue
//
// resolveTechnicalIndicators() is the single enforcement point that replaces
// taIndicators.computeAll() everywhere in the codebase.

const TECHNICAL_REGISTRY = {};

function defTA(id, meta) {
  TECHNICAL_REGISTRY[id] = { id, computationType: 'technical', ...meta };
}

for (const e of [...require('./technicalEntries.a'), ...require('./technicalEntries.b')]) {
  defTA(e.id, e);
}

// ── Batch Resolver ────────────────────────────────────────────────────────────

/**
 * Single enforcement point replacing taIndicators.computeAll() everywhere.
 * Calls computeAll() once, then maps output through TECHNICAL_REGISTRY entries.
 *
 * @param {Array<{date,open,high,low,close,volume}>} dailyBars   oldest→newest
 * @param {Array<{date,open,high,low,close,volume}>} weeklyBars
 * @param {Array<{date,open,high,low,close,volume}>} monthlyBars
 * @param {object|null} quote  synthetic quote (regularMarketPrice, fiftyTwoWeekHigh, …)
 * @returns {{ daily: object, weekly: object, monthly: object }}
 */
function resolveTechnicalIndicators(dailyBars = [], weeklyBars = [], monthlyBars = [], quote = null) {
  const raw = taIndicators.computeAll(dailyBars, weeklyBars, monthlyBars, quote);
  const out = { daily: {}, weekly: {}, monthly: {} };

  for (const entry of Object.values(TECHNICAL_REGISTRY)) {
    for (const tf of (entry.taAppliesTo ?? ['daily'])) {
      const v = (raw[tf] ?? {})[entry.taKey];
      out[tf][entry.taKey] = v !== undefined ? v : null;
    }
  }

  return out;
}

/**
 * Resolve indicator series (arrays of {date, value}) for chart rendering.
 * Wraps taIndicators.computeIndicatorSeries() so all series data routes
 * through this registry file rather than calling taIndicators directly.
 *
 * @param {Array<{date,open,high,low,close,volume}>} bars
 * @returns {object}  keyed by indicator name, values are [{date, value}] arrays
 */
function resolveIndicatorSeries(bars) {
  return taIndicators.computeIndicatorSeries(bars);
}

module.exports = { TECHNICAL_REGISTRY, resolveTechnicalIndicators, resolveIndicatorSeries };
