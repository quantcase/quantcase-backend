'use strict';

const { resolveMetric } = require('./financial');

/**
 * Source KPI abbrs needed to compute all derived KPIs via resolveMetric.
 * Pass this to fetchTimeSeriesBatch.
 */
const SOURCE_ABBRS = [
  'REV_OP', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
  'EMP_EXP', 'DEP_AMORT', 'OTH_EXP',
  'PBT', 'FIN_COST', 'PAT',
  'TOTAL_ASSETS', 'CURR_LIAB',
  'EQ_SHARE_CAP', 'RES_SURPLUS',
  'ASSET_PPE', 'ASSET_CWIP',
  'CFO', 'CFI', 'CFF', 'PROV_CONT',
  // PPE breakdown — used for granular CAPEX calculation
  'ASSET_LAND_NET', 'ASSET_MINING_NET', 'ASSET_BIO_NET', 'ASSET_LEASE_IMP_NET', 'ASSET_BLDG_NET',
  'ASSET_LAND_GRS', 'ASSET_PM_NET', 'ASSET_IT_NET', 'ASSET_ELEC_NET', 'ASSET_PM_GRS',
  'ASSET_TRANS_NET', 'ASSET_FURN_NET',
];

/**
 * Registry-enforced period-by-period resolver for prowess time-series data.
 *
 * All derived metrics route through resolveMetric() — the single enforcement
 * point — so admin view matches screener cards exactly.
 *
 * The registry is fully context-aware: callers pass { kpiMap, prevKpiMap, bfsi }
 * and the registry handles all variants internally (BFSI formula selection,
 * CAPEX delta resolution, etc.)
 *
 * Return shape: { EBIT, EBIT_MARGIN, ROCE, ROA, ROE, CAPEX, FCF }
 * each is an array of { callId, period, fiscal_year, quarter, call_date, value, abbrUsed }
 *
 * @param {Record<string, Array<{ value: number|null, ... }>>} raw
 *   Output of fetchTimeSeriesBatch with SOURCE_ABBRS — arrays aligned by period.
 * @param {boolean} [bfsi=false]
 */
function computeRegistryDerivedSeries(raw, bfsi = false) {
  const anchor = raw['REV_OP'];
  if (!anchor || !anchor.length) {
    return { EBIT: [], EBIT_MARGIN: [], ROCE: [], ROA: [], ROE: [], CAPEX: [], FCF: [] };
  }

  const ebit = [], ebitMargin = [], roce = [], roa = [], roe = [], capex = [], fcf = [];

  for (let i = 0; i < anchor.length; i++) {
    const base = {
      callId:      anchor[i].callId,
      period:      anchor[i].period,
      fiscal_year: anchor[i].fiscal_year,
      quarter:     anchor[i].quarter,
      call_date:   anchor[i].call_date,
    };
    const v = abbr => raw[abbr]?.[i]?.value ?? null;

    // Build per-period kpiMap
    const kpiMap = {};
    for (const abbr of Object.keys(raw)) {
      const val = v(abbr);
      if (val != null) kpiMap[abbr] = val;
    }
    if (kpiMap['BORR_TOTAL'] == null && (kpiMap['DEBT_LT'] != null || kpiMap['DEBT_ST'] != null)) {
      kpiMap['BORR_TOTAL'] = (kpiMap['DEBT_LT'] ?? 0) + (kpiMap['DEBT_ST'] ?? 0);
    }

    // Build prevKpiMap for CAPEX delta resolution (null for i=0)
    let prevKpiMap = null;
    if (i > 0) {
      prevKpiMap = {};
      for (const abbr of Object.keys(raw)) {
        const val = raw[abbr]?.[i - 1]?.value ?? null;
        if (val != null) prevKpiMap[abbr] = val;
      }
    }

    const ctx = { kpiMap, prevKpiMap, bfsi };

    const roceRes       = bfsi ? { value: null } : resolveMetric('ROCE',        ctx);
    const roaRes        = resolveMetric('ROA',         ctx);
    const roeRes        = resolveMetric('ROE',         ctx);
    const capexRes      = resolveMetric('CAPEX',       ctx);
    const ebitRes       = resolveMetric('EBIT',        ctx);
    const ebitMarginRes = resolveMetric('EBIT_MARGIN', ctx);
    const fcfRes        = resolveMetric('FCF',         ctx);

    roce.push      ({ ...base, value: roceRes.value,        abbrUsed: 'ROCE' });
    roa.push       ({ ...base, value: roaRes.value,         abbrUsed: 'ROA' });
    roe.push       ({ ...base, value: roeRes.value,         abbrUsed: 'ROE' });
    capex.push     ({ ...base, value: capexRes.value,       abbrUsed: 'CAPEX' });
    ebit.push      ({ ...base, value: ebitRes.value,        abbrUsed: bfsi ? 'PPOP' : 'EBIT' });
    ebitMargin.push({ ...base, value: ebitMarginRes.value,  abbrUsed: 'EBIT_MARGIN' });
    fcf.push       ({ ...base, value: fcfRes.value,         abbrUsed: 'FCF' });
  }

  return { EBIT: ebit, EBIT_MARGIN: ebitMargin, ROCE: roce, ROA: roa, ROE: roe, CAPEX: capex, FCF: fcf };
}

module.exports = { SOURCE_ABBRS, computeRegistryDerivedSeries };
