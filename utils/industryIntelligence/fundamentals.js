'use strict';

// YoY growth from the last two annual values in a prowess time-series.
function yoyGrowthFromSeries(series) {
  const annual = (series ?? []).filter(s => s.value != null);
  if (annual.length < 2) return null;
  const prev = annual.at(-2).value;
  const curr = annual.at(-1).value;
  if (prev == null || prev === 0) return null;
  return (curr - prev) / Math.abs(prev) * 100;
}

function latestFromSeries(series) {
  if (!series?.length) return null;
  const valid = series.filter(s => s.value != null);
  return valid.length ? valid.at(-1).value : null;
}

/**
 * Extract growth, profitability, and balance-sheet raw values from a
 * getTimeSeriesBatch result + getDerivedKpiBatch result.
 *
 * @param {Record<string, Array>} raw     — output of getTimeSeriesBatch
 * @param {Record<string, Array>} derived — output of getDerivedKpiBatch
 * @param {boolean} bfsi
 * @param {string}  source  — 'prowess' | 'kpi_values' (for logging)
 * @returns {{ rev_yoy, pat_yoy, roce, ebit_margin, roe, roa, de, cr, ic }}
 */
function extractMetrics(raw, derived, bfsi, source) {
  const rev_yoy     = yoyGrowthFromSeries(raw['REV_OP']);
  const pat_yoy     = yoyGrowthFromSeries(raw['PAT']);

  const ebit_margin = latestFromSeries(derived['EBIT_MARGIN']);
  const roe         = latestFromSeries(derived['ROE']);
  const roa         = latestFromSeries(derived['ROA']);

  // Prefer stored ROCE from prowess over the derived formula
  let roce = latestFromSeries(raw['ROCE']);
  if (roce == null) roce = latestFromSeries(derived['ROCE']);

  const de = latestFromSeries(raw['DE']);
  // IC and CR are not meaningful for BFSI balance-sheet scoring
  const cr = bfsi ? null : latestFromSeries(raw['CR']);
  const ic = bfsi ? null : latestFromSeries(raw['IC']);

  return { rev_yoy, pat_yoy, roce, ebit_margin, roe, roa, de, cr, ic, _source: source };
}

/**
 * Compute fundamental metrics for a single ticker.
 * Tries ProwessHelper first; falls back to FinHelper with a console.log.
 *
 * @param {string}  ticker
 * @param {boolean} bfsi
 * @param {import('../prowessHelper').ProwessHelper} prowess
 * @param {import('../finHelper').FinHelper}         finHelper
 */
async function computeFundamentals(ticker, bfsi, prowess, finHelper) {
  const ABBRS = ['REV_OP', 'PAT', 'ROCE', 'DE', 'CR', 'IC'];

  const [rawBatch, derived] = await Promise.all([
    prowess.getTimeSeriesBatch(ticker, ABBRS),
    prowess.getDerivedKpiBatch(ticker, bfsi),
  ]);

  const hasData = Object.values(rawBatch).some(s => s.length > 0);

  if (!hasData) {
    console.log(`[IIT][fallback] ${ticker}: no prowess data → trying kpi_values`);
    const [fbRaw, fbDerived] = await Promise.all([
      finHelper.getTimeSeriesBatch(ticker, ABBRS),
      finHelper.getDerivedKpiBatch(ticker, bfsi),
    ]);
    return extractMetrics(fbRaw, fbDerived, bfsi, 'kpi_values');
  }

  // Per-metric fallback: if a specific KPI is null in prowess, try kpi_values
  const result = extractMetrics(rawBatch, derived, bfsi, 'prowess');

  const metricsToFallback = ['de', 'cr', 'ic', 'roce'].filter(m => result[m] == null);
  if (metricsToFallback.length) {
    const fbAbbrs = metricsToFallback.map(m => m.toUpperCase());
    console.log(`[IIT][fallback] ${ticker} ${fbAbbrs.join(',')}: prowess null → kpi_values`);
    const fbRaw = await finHelper.getTimeSeriesBatch(ticker, fbAbbrs);
    for (const m of metricsToFallback) {
      result[m] = latestFromSeries(fbRaw[m.toUpperCase()]);
    }
  }

  return result;
}

module.exports = { computeFundamentals };
