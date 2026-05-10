'use strict';

const { cagr, average, periodLabel } = require('./math');
const { computeRegistryDerivedSeries, SOURCE_ABBRS } = require('./seriesResolver');
const { fetchTimeSeries, fetchTimeSeriesBatch } = require('./dataFetcherCore');
const { getHistoricPeForTickers } = require('../../services/db/historicPe.db');

// ── Shared utility ────────────────────────────────────────────────────────────

async function fetchIndustryTickers(prisma, industry) {
  const rows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: industry },
    select:   { company: true },
    distinct: ['company'],
  });
  return rows.map(r => r.company);
}

// ── Prowess-backed: stock-level ───────────────────────────────────────────────

/**
 * Latest non-null annual value from prowess_values_new.
 * @returns {{ value, abbrUsed, period, type: 'latest_value'|'no_data' }}
 */
async function fetchStockLatest(prisma, ticker, abbr) {
  const series     = await fetchTimeSeries(prisma, ticker, abbr);
  const withValues = series.filter(s => s.value != null);
  if (!withValues.length) return { value: null, abbrUsed: null, period: null, type: 'no_data' };
  const latest = withValues.at(-1);
  return { value: latest.value, abbrUsed: latest.abbrUsed, period: latest.period, type: 'latest_value' };
}

/**
 * Annual CAGR from prowess_values_new.
 * spanYears = periods − 1 (each prowess row = 1 fiscal year).
 * @returns {{ value, type, spanYears, periodsUsed, abbrUsed, firstValue, latestValue }}
 */
async function fetchStockCagr(prisma, ticker, abbr, targetYears = 3) {
  const series     = await fetchTimeSeries(prisma, ticker, abbr);
  const withValues = series.filter(s => s.value != null);

  if (!withValues.length) return { value: null, type: 'no_data', periodsUsed: 0 };

  const latest = withValues.at(-1);
  if (withValues.length === 1) {
    return { value: latest.value, type: 'latest_value', periodsUsed: 1,
             abbrUsed: latest.abbrUsed, note: 'Only one annual period' };
  }

  const first     = withValues[0];
  const spanYears = withValues.length - 1;

  if (first.value == null || first.value <= 0) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             abbrUsed: latest.abbrUsed, note: 'Non-positive base — returning latest' };
  }

  const cagrValue = cagr(first.value, latest.value, spanYears);
  if (cagrValue == null || isNaN(cagrValue)) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             abbrUsed: latest.abbrUsed, note: 'CAGR undefined — returning latest' };
  }

  return {
    value:       parseFloat(cagrValue.toFixed(2)),
    type:        spanYears >= 2 ? 'cagr' : 'partial_cagr',
    spanYears,
    periodsUsed: withValues.length,
    abbrUsed:    latest.abbrUsed,
    firstValue:  first.value,
    latestValue: latest.value,
  };
}

// ── Prowess-backed: industry-level ────────────────────────────────────────────

/**
 * Average CAGR across all tickers in an industry (prowess).
 * @returns {{ value, type, tickerCount, validTickerCount, tickers }}
 */
async function fetchIndustryCagr(prisma, industry, abbr, targetYears = 3) {
  const tickers = await fetchIndustryTickers(prisma, industry);
  if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

  const results = await Promise.allSettled(
    tickers.map(t => fetchStockCagr(prisma, t, abbr, targetYears))
  );

  const cagrValues = results
    .filter(r => r.status === 'fulfilled' && r.value.value != null && !isNaN(r.value.value) && r.value.type.includes('cagr'))
    .map(r => r.value.value);

  const avg = average(cagrValues);
  return {
    value:            avg != null ? parseFloat(avg.toFixed(2)) : null,
    type:             'cagr',
    tickerCount:      tickers.length,
    validTickerCount: cagrValues.length,
    tickers,
  };
}

/**
 * Simple average of the latest value for any abbr across all tickers in an industry.
 * @returns {{ value, abbrUsed, sampleSize }}
 */
async function fetchIndustryAvg(prisma, industry, abbr) {
  const tickers = await fetchIndustryTickers(prisma, industry);
  if (!tickers.length) return { value: null, abbrUsed: abbr, sampleSize: 0 };

  const results = await Promise.allSettled(
    tickers.map(t => fetchStockLatest(prisma, t, abbr))
  );

  const valid = results
    .filter(r => r.status === 'fulfilled' && r.value.value != null)
    .map(r => r.value);

  const avg = average(valid.map(v => v.value));
  return {
    value:      avg != null ? parseFloat(avg.toFixed(2)) : null,
    abbrUsed:   valid[0]?.abbrUsed ?? abbr,
    sampleSize: valid.length,
  };
}

/**
 * Convenience wrapper: fetches all SOURCE_ABBRS from prowess and applies the
 * registry-enforced computeRegistryDerivedSeries (EBIT, ROCE, ROA, ROE, CAPEX, FCF, …).
 * Always uses registry computation — unlike FinHelper.getDerivedKpiBatch which used
 * the non-registry computeDerivedKpis.
 */
async function fetchDerivedBatch(prisma, ticker, bfsi = false) {
  const raw = await fetchTimeSeriesBatch(prisma, ticker, SOURCE_ABBRS);
  return computeRegistryDerivedSeries(raw, bfsi);
}

// ── PE CAGR (pe_data table) ───────────────────────────────────────────────────

function _quarterLabelToYear(label) {
  const m = label && label.match(/^(\d{4})Q(\d)$/);
  if (!m) return null;
  return parseInt(m[1]) + (parseInt(m[2]) - 0.5) * 0.25;
}

/**
 * PE CAGR for a single stock from quarterly pe_data buckets.
 * @returns {{ value, type, spanYears, periodsUsed, firstPe, latestPe, avgPe }}
 */
async function fetchStockPeCagr(prisma, ticker, targetYears = 5) {
  const [result] = await getHistoricPeForTickers([ticker]);

  if (!result || result.error) {
    return { value: null, type: result?.error ? 'error' : 'no_data', periodsUsed: 0 };
  }

  const qpe = result.quarterlyPe ?? [];
  if (!qpe.length) return { value: null, type: 'no_data', periodsUsed: 0 };

  const latestPe = qpe.at(-1).avgPe;
  const avgPe    = average(qpe.map(q => q.avgPe));

  if (qpe.length === 1) {
    return { value: latestPe, type: 'latest_value', periodsUsed: 1, latestPe,
             avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null };
  }

  const firstYear = _quarterLabelToYear(qpe.at(0).quarter);
  const lastYear  = _quarterLabelToYear(qpe.at(-1).quarter);
  const spanYears = (firstYear != null && lastYear != null)
    ? (lastYear - firstYear)
    : qpe.length * 0.25;

  const firstPe = qpe.at(0).avgPe;

  if (spanYears <= 0) {
    return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
             latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null };
  }

  const cagrValue = cagr(firstPe, latestPe, spanYears);
  if (cagrValue == null || isNaN(cagrValue)) {
    return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
             latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
             note: 'CAGR undefined — returning latest PE' };
  }

  return {
    value:       parseFloat(cagrValue.toFixed(2)),
    type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
    spanYears:   parseFloat(spanYears.toFixed(2)),
    periodsUsed: qpe.length,
    firstPe,
    latestPe,
    avgPe:       avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
  };
}

/**
 * Average PE CAGR across all tickers in an industry.
 * @returns {{ value, type, tickerCount, validTickerCount, avgLatestPe, tickers }}
 */
async function fetchIndustryPeCagr(prisma, industry, targetYears = 5) {
  const tickers = await fetchIndustryTickers(prisma, industry);
  if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

  const results = await Promise.allSettled(
    tickers.map(t => fetchStockPeCagr(prisma, t, targetYears))
  );

  const settled = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  const cagrValues = settled.filter(r => r.value != null && !isNaN(r.value) && r.type.includes('cagr')).map(r => r.value);
  const latestPes  = settled.filter(r => r.latestPe != null && !isNaN(r.latestPe)).map(r => r.latestPe);

  const avgCagr   = average(cagrValues);
  const avgLatest = average(latestPes);
  return {
    value:            avgCagr   != null ? parseFloat(avgCagr.toFixed(2))   : null,
    type:             '5yr_cagr',
    tickerCount:      tickers.length,
    validTickerCount: cagrValues.length,
    avgLatestPe:      avgLatest != null ? parseFloat(avgLatest.toFixed(2)) : null,
    tickers,
  };
}

// ── kpiValue-backed (earnings call data) ─────────────────────────────────────

/**
 * Time-series for a single abbr from kpiValue (earnings call extracted data).
 * Mirrors FinHelper.getTimeSeries — stateless.
 * @returns {Promise<Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>}
 */
async function fetchEarningsTimeSeries(prisma, ticker, abbr) {
  const calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker },
    select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
    orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
  });
  if (!calls.length) return [];

  const kpiRows = await prisma.kpiValue.findMany({
    where:  { callId: { in: calls.map(c => c.id) }, kpi_abbr: abbr },
    select: { callId: true, value: true, multiplier: true },
  });
  const kpiMap = new Map(kpiRows.map(r => [r.callId, r.value / (r.multiplier || 1)]));

  return calls.map(call => {
    const raw   = kpiMap.get(call.id);
    const value = raw != null && !isNaN(raw) ? raw : null;
    return {
      callId:      call.id,
      period:      periodLabel(call),
      fiscal_year: call.fiscal_year,
      quarter:     call.quarter,
      call_date:   call.call_date,
      value,
      abbrUsed:    value != null ? abbr : null,
    };
  });
}

/**
 * Batch time-series from kpiValue — single DB round-trip.
 * @returns {Promise<Record<string, Array<...>>>}
 */
async function fetchEarningsTimeSeriesBatch(prisma, ticker, abbrs) {
  const calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker },
    select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
    orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
  });

  const result = Object.fromEntries(abbrs.map(a => [a, []]));
  if (!calls.length) return result;

  const callIds = calls.map(c => c.id);
  const kpiRows = await prisma.kpiValue.findMany({
    where:  { callId: { in: callIds }, kpi_abbr: { in: abbrs } },
    select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
  });

  const kpiMap = {};
  for (const row of kpiRows) {
    if (!kpiMap[row.callId]) kpiMap[row.callId] = {};
    if (kpiMap[row.callId][row.kpi_abbr] === undefined) {
      kpiMap[row.callId][row.kpi_abbr] = row.value / (row.multiplier || 1);
    }
  }

  for (const call of calls) {
    const base = {
      callId:      call.id,
      period:      periodLabel(call),
      fiscal_year: call.fiscal_year,
      quarter:     call.quarter,
      call_date:   call.call_date,
    };
    for (const abbr of abbrs) {
      const raw   = kpiMap[call.id]?.[abbr];
      const value = raw != null && !isNaN(raw) ? raw : null;
      result[abbr].push({ ...base, value, abbrUsed: value != null ? abbr : null });
    }
  }

  return result;
}

/**
 * Latest non-null value from kpiValue.
 * @returns {{ value, abbrUsed, period, type }}
 */
async function fetchEarningsLatest(prisma, ticker, abbr) {
  const series     = await fetchEarningsTimeSeries(prisma, ticker, abbr);
  const withValues = series.filter(s => s.value != null);
  if (!withValues.length) return { value: null, abbrUsed: null, period: null, type: 'no_data' };
  const latest = withValues.at(-1);
  return { value: latest.value, abbrUsed: latest.abbrUsed, period: latest.period, type: 'latest_value' };
}

/**
 * CAGR from kpiValue using date-span (same as FinHelper.stockKpiCagr).
 * @returns {{ value, type, spanYears, periodsUsed, abbrUsed, firstValue, latestValue }}
 */
async function fetchEarningsCagr(prisma, ticker, abbr, targetYears = 5) {
  const series     = await fetchEarningsTimeSeries(prisma, ticker, abbr);
  const withValues = series.filter(s => s.value != null);

  if (!withValues.length) return { value: null, type: 'no_data', periodsUsed: 0 };

  const latest = withValues.at(-1);
  if (withValues.length === 1) {
    return { value: latest.value, type: 'latest_value', periodsUsed: 1,
             abbrUsed: latest.abbrUsed, note: 'Only one period available' };
  }

  const first = withValues.at(0);
  let spanYears;
  if (first.call_date && latest.call_date) {
    const ms = new Date(latest.call_date) - new Date(first.call_date);
    spanYears = ms / (1000 * 60 * 60 * 24 * 365.25);
  } else {
    spanYears = withValues.length / 4;
  }

  if (spanYears <= 0) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             abbrUsed: latest.abbrUsed, note: 'Zero time span' };
  }

  const cagrValue = cagr(first.value, latest.value, spanYears);
  if (cagrValue == null || isNaN(cagrValue)) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             abbrUsed: latest.abbrUsed, note: 'CAGR undefined — returning latest' };
  }

  return {
    value:       parseFloat(cagrValue.toFixed(2)),
    type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
    spanYears:   parseFloat(spanYears.toFixed(2)),
    periodsUsed: withValues.length,
    abbrUsed:    latest.abbrUsed,
    firstValue:  first.value,
    latestValue: latest.value,
  };
}

module.exports = {
  fetchIndustryTickers,
  fetchStockLatest,
  fetchStockCagr,
  fetchIndustryCagr,
  fetchIndustryAvg,
  fetchDerivedBatch,
  fetchStockPeCagr,
  fetchIndustryPeCagr,
  fetchEarningsTimeSeries,
  fetchEarningsTimeSeriesBatch,
  fetchEarningsLatest,
  fetchEarningsCagr,
};
