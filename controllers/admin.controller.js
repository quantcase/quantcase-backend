'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const adminService  = require('../services/admin.service');
const {
  REGISTRY, resolveMetric,
  TECHNICAL_REGISTRY, resolveTechnicalIndicators,
  SOURCE_ABBRS, computeRegistryDerivedSeries,
  resolveProwessName, fetchKpiMapsMulti, fetchTimeSeries, fetchTimeSeriesBatch,
} = require('../utils/formulaRegistry/index');
const technicalAnalysis                   = require('../lib/technicalAnalysis');
const prisma                              = require('../config/prisma');

const getOpportunityStats = asyncHandler(async (req, res) => {
  const { callId } = req.query;
  const result = await adminService.computeOpportunityStats(callId);
  res.json({ success: true, ...result });
});

// ── GET /admin/indicators ──────────────────────────────────────────────────────
// Registry catalogue — loaded once when admin page opens; populates the metric
// search bar.  No DB call — reads the in-memory REGISTRY only.
function listIndicators(_req, res) {
  const toShape = (e) => ({
    id:              e.id,
    name:            e.name,
    computationType: e.computationType,
    unit:            e.unit        ?? null,
    desc:            e.desc        ?? null,
    formula:         typeof e.formula === 'object' && !Array.isArray(e.formula)
      ? e.formula : (e.formula ?? null),
    inputs:          e.inputs ?? null,
    // technical-only fields
    taKey:           e.taKey        ?? null,
    taAppliesTo:     e.taAppliesTo  ?? null,
  });

  const financial  = Object.values(REGISTRY).map(toShape);
  const technical  = Object.values(TECHNICAL_REGISTRY).map(toShape);
  const indicators = [...financial, ...technical];
  res.json({ success: true, count: indicators.length, indicators });
}

// ── GET /admin/indicators/:ticker/:metricId ────────────────────────────────────
// Full provenance for one metric for a given ticker.
//
// formula / delta types → kpiMap + prevKpiMap (latest two annual periods)
// cagr types            → raw time-series for the input abbr (EPS_BASIC, REV_OP, PAT)
// average types         → derived time-series (ROCE, ROE via computeRegistryDerivedSeries)
//
// Optional query params:
//   bfsi=1   — force BFSI formula variant (EBIT→PPOP, FCF−PROV_CONT, etc.)
// ── GET /admin/indicators/:ticker/:metricId ────────────────────────────────────
// Full provenance for one metric for a given ticker.
//
// Optional query params:
//   bfsi=1           — force BFSI formula variant
//   granularity=quarterly  — use prowess_qtr_% (standalone quarterly) instead of
//                            prowess_new_% (annual audited).  Only applies to
//                            raw / formula / delta types; cagr and average always
//                            use the annual series.
const getIndicatorProvenance = asyncHandler(async (req, res) => {
  const ticker       = req.params.ticker.toUpperCase();
  const metricId     = req.params.metricId.toUpperCase();
  const bfsi         = req.query.bfsi === '1' || req.query.bfsi === 'true';
  const granularity  = req.query.granularity === 'quarterly' ? 'quarterly' : 'annual';
  const periodsCount = Math.min(Math.max(parseInt(req.query.periods, 10) || 1, 1), 20);

  // Check technical registry first — no Prowess lookup needed
  const taEntry = TECHNICAL_REGISTRY[metricId];
  if (taEntry) {
    const marketData = await technicalAnalysis.fetchMarketData(ticker);
    const rawIndicators = resolveTechnicalIndicators(
      marketData.dailyBars,
      marketData.weeklyBars,
      marketData.monthlyBars,
      marketData.quote
    );

    const tfs = taEntry.taAppliesTo ?? ['daily'];
    const data = {};
    for (const tf of tfs) {
      data[tf] = (rawIndicators[tf] ?? {})[taEntry.taKey] ?? null;
    }

    return res.json({
      success:     true,
      ticker,
      metricId,
      name:        taEntry.name,
      unit:        taEntry.unit ?? null,
      formula:     taEntry.formula ?? null,
      taKey:       taEntry.taKey,
      taAppliesTo: tfs,
      data,
    });
  }

  const entry = REGISTRY[metricId];
  if (!entry) {
    return res.status(404).json({
      success: false,
      error:   `Unknown metric "${metricId}". Call GET /admin/indicators for the full catalogue.`,
    });
  }

  const companyName = await resolveProwessName(prisma, ticker);
  if (!companyName) {
    return res.status(404).json({
      success: false,
      error:   `No Prowess data found for ticker "${ticker}".`,
    });
  }

  let result;

  if (entry.computationType === 'raw' ||
      entry.computationType === 'formula' ||
      entry.computationType === 'delta') {
    const periodMaps = await fetchKpiMapsMulti(prisma, companyName, granularity, periodsCount);
    const data = [];
    for (let i = 0; i < Math.min(periodsCount, periodMaps.length); i++) {
      const { fiscal_year, quarter, kpiMap } = periodMaps[i];
      const prevKpiMap = periodMaps[i + 1]?.kpiMap ?? null;
      const resolved = resolveMetric(metricId, { kpiMap, prevKpiMap, bfsi });
      data.push({ fiscal_year, quarter, ...resolved });
    }
    result = { data };

  } else if (entry.computationType === 'cagr') {
    // Time-series metric — always uses annual prowess data (granularity ignored).
    // defaultWindow (if set) is applied inside _resolveCagr automatically.
    const inputAbbr = entry.inputs[0];
    const series    = await fetchTimeSeries(prisma, ticker, inputAbbr);
    result = resolveMetric(metricId, { series, bfsi });

  } else if (entry.computationType === 'average') {
    // Average over derived series — always annual (granularity ignored).
    const inputAbbr = entry.inputs[0];
    const raw       = await fetchTimeSeriesBatch(prisma, ticker, SOURCE_ABBRS);
    const derived   = computeRegistryDerivedSeries(raw, bfsi);
    const series    = derived[inputAbbr] ?? [];
    result = resolveMetric(metricId, { series, bfsi, window: entry.defaultWindow });
  }

  const isSinglePeriodType = ['raw', 'formula', 'delta'].includes(entry.computationType);
  res.json({
    success:     true,
    ticker,
    company:     companyName,
    metricId,
    name:        entry.name,
    unit:        entry.unit ?? null,
    bfsi,
    granularity: isSinglePeriodType ? granularity : 'annual',
    ...(isSinglePeriodType && { periods: periodsCount }),
    ...result,
  });
});

module.exports = { getOpportunityStats, listIndicators, getIndicatorProvenance };
