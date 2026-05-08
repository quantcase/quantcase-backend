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
    inputs: Array.isArray(e.inputs)
      ? e.inputs
      : e.inputs,
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
const getIndicatorProvenance = asyncHandler(async (req, res) => {
  const ticker   = req.params.ticker.toUpperCase();
  const metricId = req.params.metricId.toUpperCase();
  const bfsi     = req.query.bfsi === '1' || req.query.bfsi === 'true';

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

  if (entry.computationType === 'formula' || entry.computationType === 'delta') {
    // Need latest two annual periods — prevKpiMap enables CAPEX delta auto-resolution
    const { current: kpiMap, prev: prevKpiMap } = await finHelper.getProwessKpiMaps(companyName);
    result = resolveMetric(metricId, { kpiMap, prevKpiMap, bfsi });

  } else if (entry.computationType === 'cagr') {
    // All CAGR inputs (EPS_BASIC, REV_OP, PAT) are raw KPIs in prowess_values_new
    const inputAbbr = entry.inputs[0];
    const series    = await prowessHelper.getTimeSeries(ticker, inputAbbr);
    result = resolveMetric(metricId, { series, bfsi });

  } else if (entry.computationType === 'average') {
    // ROCE_3Y_AVG, ROE_3Y_AVG — inputs are derived metrics, not stored raw
    const inputAbbr = entry.inputs[0];
    const raw       = await prowessHelper.getTimeSeriesBatch(ticker, SOURCE_ABBRS);
    const derived   = computeRegistryDerivedSeries(raw, bfsi);
    const series    = derived[inputAbbr] ?? [];
    result = resolveMetric(metricId, { series, bfsi, window: entry.defaultWindow });
  }

  res.json({
    success:  true,
    ticker,
    company:  companyName,
    metricId,
    name:     entry.name,
    unit:     entry.unit ?? null,
    bfsi,
    ...result,
  });
});

module.exports = { getOpportunityStats, listIndicators, getIndicatorProvenance };
