'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const adminService  = require('../services/admin.service');
const { REGISTRY, resolveMetric }         = require('../utils/formulaRegistry');
const { SOURCE_ABBRS, computeRegistryDerivedSeries } = require('../utils/finDerivedKpis');
const { ProwessHelper }                   = require('../utils/prowessHelper');
const { FinHelper }                       = require('../utils/finHelper');
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
  const indicators = Object.values(REGISTRY).map(e => ({
    id:              e.id,
    name:            e.name,
    computationType: e.computationType,
    unit:            e.unit   ?? null,
    desc:            e.desc   ?? null,
    // formula and inputs may be { standard, bfsi } objects for BFSI-variant metrics
    formula: typeof e.formula === 'object' && !Array.isArray(e.formula)
      ? e.formula
      : (e.formula ?? null),
    inputs: e.inputs == null ? null : (Array.isArray(e.inputs) ? e.inputs : e.inputs),
  }));
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

  const entry = REGISTRY[metricId];
  if (!entry) {
    return res.status(404).json({
      success: false,
      error:   `Unknown metric "${metricId}". Call GET /admin/indicators for the full catalogue.`,
    });
  }

  const prowessHelper = new ProwessHelper(prisma);
  const finHelper     = new FinHelper(prisma);

  const companyName = await prowessHelper.resolveProwessName(ticker);
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
    const periodMaps = await finHelper.getProwessKpiMapsMulti(companyName, granularity, periodsCount);
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
    const series    = await prowessHelper.getTimeSeries(ticker, inputAbbr);
    result = resolveMetric(metricId, { series, bfsi });

  } else if (entry.computationType === 'average') {
    // Average over derived series — always annual (granularity ignored).
    const inputAbbr = entry.inputs[0];
    const raw       = await prowessHelper.getTimeSeriesBatch(ticker, SOURCE_ABBRS);
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
