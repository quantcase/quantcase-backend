'use strict';

const prisma    = require('../lib/prisma');
const jobQueue  = require('../lib/jobQueue');
const { FinHelper } = require('../utils/finHelper');
const { getHistoricPeForTickers } = require('../db-utils/getHistoricPe');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a "YYYYQN" quarter label to a decimal year (midpoint of the quarter).
 * e.g. "2023Q1" → 2023.125, "2025Q4" → 2025.875
 */
function quarterLabelToYear(label) {
  const match = label && label.match(/^(\d{4})Q(\d)$/);
  if (!match) return null;
  const year = parseInt(match[1]);
  const q    = parseInt(match[2]);
  return year + (q - 0.5) * 0.25;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock-level calculations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute EPS CAGR for a single stock.
 * Falls back to latest value when < 2 data points or when base EPS is non-positive.
 */
async function computeStockEpsCagr(helper, ticker, targetYears = 5) {
  const series     = await helper.getTimeSeries(ticker, 'EPS');
  const withValues = series.filter(s => s.value != null);

  console.log(`[EPS] ${ticker} — ${series.length} periods total, ${withValues.length} with values`);
  withValues.forEach(s => console.log(`  ${s.period}  eps=${s.value}  resolvedAbbr=${s.resolvedAbbr}`));

  if (withValues.length === 0) {
    return { value: null, type: 'no_data', periodsUsed: 0 };
  }

  const latest = withValues.at(-1);

  if (withValues.length === 1) {
    console.log(`[EPS] ${ticker} — only 1 period, returning latest_value=${latest.value}`);
    return { value: latest.value, type: 'latest_value', periodsUsed: 1,
             note: 'Only one period available — CAGR not computable' };
  }

  const first = withValues.at(0);
  let spanYears;
  if (first.call_date && latest.call_date) {
    const ms = new Date(latest.call_date) - new Date(first.call_date);
    spanYears = ms / (1000 * 60 * 60 * 24 * 365.25);
  } else {
    spanYears = withValues.length / 4;
  }

  console.log(`[EPS] ${ticker} — first=${first.value} (${first.period}), latest=${latest.value} (${latest.period}), span=${spanYears.toFixed(2)} yrs`);

  if (spanYears <= 0) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             note: 'Zero time span' };
  }

  const cagrValue = FinHelper.cagr(first.value, latest.value, spanYears);
  console.log(`[EPS] ${ticker} — cagrValue=${cagrValue}`);

  if (cagrValue == null || isNaN(cagrValue)) {
    return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
             note: 'CAGR undefined (negative/zero base EPS) — returning latest value' };
  }

  return {
    value:       parseFloat(cagrValue.toFixed(2)),
    type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
    spanYears:   parseFloat(spanYears.toFixed(2)),
    periodsUsed: withValues.length,
    firstValue:  first.value,
    latestValue: latest.value,
  };
}

/**
 * Compute P/E CAGR for a single stock from quarterly PE history.
 */
async function computeStockPeCagr(ticker, targetYears = 5) {
  const [result] = await getHistoricPeForTickers([ticker]);
  console.log(`[PE] ${ticker} — ${result?.quarterlyPe?.length ?? 0} quarterly buckets`);

  if (!result || result.error) {
    return { value: null, type: result?.error ? 'error' : 'no_data', periodsUsed: 0 };
  }

  const qpe = result.quarterlyPe ?? [];
  if (qpe.length === 0) return { value: null, type: 'no_data', periodsUsed: 0 };

  qpe.forEach(q => console.log(`  [PE] ${q.quarter}  avgPe=${q.avgPe}  dataPoints=${q.dataPoints}`));

  const latestPe = qpe.at(-1).avgPe;
  const avgPe    = FinHelper.average(qpe.map(q => q.avgPe));
  console.log(`[PE] ${ticker} — latestPe=${latestPe}, overallAvgPe=${avgPe}`);

  if (qpe.length === 1) {
    return { value: latestPe, type: 'latest_value', periodsUsed: 1, latestPe,
             avgPe, note: 'Only one quarter available' };
  }

  const firstYear = quarterLabelToYear(qpe.at(0).quarter);
  const lastYear  = quarterLabelToYear(qpe.at(-1).quarter);
  const spanYears = (firstYear != null && lastYear != null)
    ? (lastYear - firstYear)
    : qpe.length * 0.25;

  const firstPe = qpe.at(0).avgPe;
  console.log(`[PE] ${ticker} — firstPe=${firstPe} (${qpe.at(0).quarter}), latestPe=${latestPe} (${qpe.at(-1).quarter}), span=${spanYears.toFixed(2)} yrs`);

  if (spanYears <= 0) {
    return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
             latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
             note: 'Zero time span' };
  }

  const cagrValue = FinHelper.cagr(firstPe, latestPe, spanYears);
  console.log(`[PE] ${ticker} — cagrValue=${cagrValue}`);

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

// ─────────────────────────────────────────────────────────────────────────────
// Industry-level calculations
// ─────────────────────────────────────────────────────────────────────────────

async function computeIndustryEpsCagr(helper, industry, targetYears = 5) {
  const tickers = await helper._industryTickers(industry);
  console.log(`[Industry EPS] "${industry}" — ${tickers.length} tickers:`, tickers);
  if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

  const results = await Promise.allSettled(
    tickers.map(t => computeStockEpsCagr(helper, t, targetYears))
  );

  results.forEach((r, i) => {
    const v = r.status === 'fulfilled' ? `value=${r.value.value}, type=${r.value.type}` : `REJECTED: ${r.reason?.message}`;
    console.log(`[Industry EPS] ${tickers[i]} → ${v}`);
  });

  const cagrValues = results
    .filter(r => r.status === 'fulfilled' && r.value.value != null && !isNaN(r.value.value) && r.value.type.includes('cagr'))
    .map(r => r.value.value);

  console.log(`[Industry EPS] valid CAGR values (${cagrValues.length}):`, cagrValues);
  const avg = FinHelper.average(cagrValues);
  return {
    value:            avg != null ? parseFloat(avg.toFixed(2)) : null,
    type:             '5yr_cagr',
    tickerCount:      tickers.length,
    validTickerCount: cagrValues.length,
    tickers,
  };
}

async function computeIndustryPeCagr(helper, industry, targetYears = 5) {
  const tickers = await helper._industryTickers(industry);
  console.log(`[Industry PE] "${industry}" — ${tickers.length} tickers:`, tickers);
  if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

  const results = await Promise.allSettled(
    tickers.map(t => computeStockPeCagr(t, targetYears))
  );

  const settled = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`[Industry PE] ${tickers[i]} → value=${r.value.value}, type=${r.value.type}, latestPe=${r.value.latestPe}`);
      return r.value;
    }
    console.log(`[Industry PE] ${tickers[i]} → REJECTED:`, r.reason?.message);
    return null;
  }).filter(Boolean);

  const cagrValues = settled.filter(r => r.value != null && !isNaN(r.value) && r.type.includes('cagr')).map(r => r.value);
  const latestPes  = settled.filter(r => r.latestPe != null && !isNaN(r.latestPe)).map(r => r.latestPe);

  console.log(`[Industry PE] CAGR values (${cagrValues.length}):`, cagrValues);
  console.log(`[Industry PE] latest PEs (${latestPes.length}):`, latestPes);

  const avgCagr   = FinHelper.average(cagrValues);
  const avgLatest = FinHelper.average(latestPes);
  return {
    value:            avgCagr   != null ? parseFloat(avgCagr.toFixed(2))   : null,
    type:             '5yr_cagr',
    tickerCount:      tickers.length,
    validTickerCount: cagrValues.length,
    avgLatestPe:      avgLatest != null ? parseFloat(avgLatest.toFixed(2)) : null,
    tickers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler — compute inputs + enqueue deal analysis job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/calls/:callId/deal/analysis
 *
 * 1. Computes stock + industry EPS/PE CAGR from DB.
 * 2. Enqueues a BullMQ 'deal_analysis' job with those inputs.
 * 3. Returns the job ID immediately (async — poll GET /api/calls/:callId/deal for result).
 */
async function createDealAnalysis(req, res) {
  try {
    const { callId } = req.params;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Deal] POST /deal/analysis  callId=${callId}`);

    const call = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { id: true, company: true, basic_industry: true, company_name: true, fiscal_year: true, quarter: true },
    });
    console.log(`[Deal] call record:`, call);

    if (!call) {
      return res.status(404).json({ success: false, error: 'Earnings call not found' });
    }

    const ticker   = call.company;
    const industry = call.basic_industry;

    const helper = new FinHelper(prisma);
    await helper._warmSubstituteCache(['EPS']);

    console.log(`\n--- Computing inputs for ${ticker} ---`);
    const [stockEps, stockPe, industryEps, industryPe] = await Promise.all([
      computeStockEpsCagr(helper, ticker, 5),
      computeStockPeCagr(ticker, 5),
      industry ? computeIndustryEpsCagr(helper, industry, 5) : Promise.resolve({ value: null, type: 'no_industry' }),
      industry ? computeIndustryPeCagr(helper, industry, 5) : Promise.resolve({ value: null, type: 'no_industry' }),
    ]);

    console.log(`\n--- Computed inputs ---`);
    console.log('stockEps:',    stockEps);
    console.log('stockPe:',     stockPe);
    console.log('industryEps:', industryEps);
    console.log('industryPe:',  industryPe);

    // Enqueue the Claude analysis job
    const bullmqJob = await jobQueue.addJob('deal_analysis', {
      callId,
      type:        'deal_analysis',
      ticker,
      companyName: call.company_name,
      industry,
      stockEps,
      stockPe,
      industryEps,
      industryPe,
    });

    return res.json({
      success: true,
      message: 'Deal analysis job created and queued',
      job: {
        id:        bullmqJob.id,
        callId,
        type:      'deal_analysis',
        status:    'pending',
        createdAt: new Date(bullmqJob.timestamp).toISOString(),
      },
    });
  } catch (error) {
    console.error('[Deal] Error creating deal analysis job:', error);
    return res.status(500).json({
      success: false,
      error:   'Failed to create deal analysis job',
      message: error.message,
    });
  }
}

module.exports = {
  createDealAnalysis,
  // Exported for potential reuse / testing
  computeStockEpsCagr,
  computeStockPeCagr,
  computeIndustryEpsCagr,
  computeIndustryPeCagr,
};
