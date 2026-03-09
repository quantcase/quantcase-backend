'use strict';

// ─── Math Primitives ──────────────────────────────────────────────────────────

/** Period-over-period growth rate (%) */
function growth(current, prev) {
  if (prev == null || prev === 0 || current == null) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

/** Compound annual growth rate (%) over `years` */
function cagr(initial, final, years) {
  if (initial == null || final == null || !years || initial <= 0) return null;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

/** Percentage margin — e.g. margin(EBIT, REV) */
function margin(part, whole) {
  if (whole == null || whole === 0 || part == null) return null;
  return (part / whole) * 100;
}

/** Generic ratio a / b */
function ratio(a, b) {
  if (b == null || b === 0 || a == null) return null;
  return a / b;
}

/** Mean of a non-null numeric array */
function average(values) {
  const nums = (values ?? []).filter(v => v != null && !isNaN(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/**
 * Market-cap-weighted average. Falls back to simple average when no valid weights exist.
 * @param {(number|null)[]} values
 * @param {(number|null)[]} weights
 */
function weightedAverage(values, weights) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = weights[i];
    if (v == null || isNaN(v) || w == null || isNaN(w) || w <= 0) continue;
    weightedSum += v * w;
    totalWeight += w;
  }
  if (totalWeight > 0) return weightedSum / totalWeight;
  return average(values);
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/**
 * Returns fn(inputs) rounded to 2 dp, or null if any input is null/NaN,
 * or if fn itself returns null/NaN.
 * @param {(number|null)[]} inputs
 * @param {(values: number[]) => number|null} fn
 * @returns {number|null}
 */
function derive(inputs, fn) {
  if (inputs.some(v => v == null || isNaN(v))) return null;
  const result = fn(inputs);
  if (result == null || isNaN(result)) return null;
  return parseFloat(result.toFixed(2));
}

function periodLabel(call) {
  return call.quarter ? `${call.fiscal_year}-${call.quarter}` : call.fiscal_year;
}

/** "YYYYQN" → decimal year at midpoint of quarter. e.g. "2023Q1" → 2023.125 */
function quarterLabelToYear(label) {
  const match = label && label.match(/^(\d{4})Q(\d)$/);
  if (!match) return null;
  return parseInt(match[1]) + (parseInt(match[2]) - 0.5) * 0.25;
}

module.exports = { growth, cagr, margin, ratio, average, weightedAverage, derive, periodLabel, quarterLabelToYear };
