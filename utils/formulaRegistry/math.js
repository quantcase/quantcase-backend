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

module.exports = { r2, growth, cagr, average, derive, periodLabel };
