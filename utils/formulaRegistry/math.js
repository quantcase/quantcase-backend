'use strict';

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

function growth(current, prev) {
  if (prev == null || prev === 0 || current == null) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

function cagr(initial, final, years) {
  if (initial == null || final == null || !years || initial <= 0) return null;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

function average(values) {
  const nums = (values ?? []).filter(v => v != null && !isNaN(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function derive(inputs, fn) {
  if (inputs.some(v => v == null || isNaN(v))) return null;
  const result = fn(inputs);
  if (result == null || isNaN(result)) return null;
  return parseFloat(result.toFixed(2));
}

function periodLabel(call) {
  return call.quarter ? `${call.fiscal_year}-${call.quarter}` : call.fiscal_year;
}

// ── Series-based aggregates for CAGR()/AVG()/SUM() expression functions ──────
// `points` — array of { value: number|null }, ordered oldest → newest, one per
// period (may include null-value periods — these are filtered out first, same
// semantics as the pre-migration _resolveCagr/_resolveAverage).

/** CAGR over the last `window+1` non-null points (or the full series if window is null). */
function cagrFromSeries(points, window) {
  const pts = (points ?? []).filter(p => p.value != null);
  if (!pts.length) return null;
  const windowed = window != null ? pts.slice(-(window + 1)) : pts;
  const first = windowed[0], last = windowed[windowed.length - 1];
  const spanYears = windowed.length - 1;
  if (windowed.length === 1) return last.value;
  if (first.value == null || first.value <= 0) return last.value;
  const val = (Math.pow(Math.abs(last.value) / first.value, 1 / spanYears) - 1) * 100 * Math.sign(last.value);
  return parseFloat(val.toFixed(2));
}

/** Arithmetic mean over the last `window` non-null points (or the full series). */
function averageFromSeries(points, window) {
  const pts = (points ?? []).filter(p => p.value != null);
  const windowed = window != null ? pts.slice(-window) : pts;
  if (!windowed.length) return null;
  return parseFloat((windowed.reduce((s, p) => s + p.value, 0) / windowed.length).toFixed(2));
}

/** Sum over the last `window` non-null points (or the full series). */
function sumFromSeries(points, window) {
  const pts = (points ?? []).filter(p => p.value != null);
  const windowed = window != null ? pts.slice(-window) : pts;
  if (!windowed.length) return null;
  return parseFloat(windowed.reduce((s, p) => s + p.value, 0).toFixed(4));
}

module.exports = {
  r2, growth, cagr, average, derive, periodLabel,
  cagrFromSeries, averageFromSeries, sumFromSeries,
};
