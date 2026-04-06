'use strict';

const { derive } = require('./finMath');

/**
 * Source KPI abbrs needed to compute all derived KPIs.
 * Pass this to getTimeSeriesBatch.
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
 * Compute derived financial KPIs from raw time-series data.
 *
 * Common (all sectors):
 *   EBIT        = REV_OP - (COST_MAT + PURCH_STOCK + INV_CHG) - EMP_EXP - DEP_AMORT - OTH_EXP
 *                 (BFSI alias: PPOP — Pre-Provisioning Operating Profit)
 *   EBIT_MARGIN = EBIT / REV_OP × 100
 *   ROA         = PAT / TOTAL_ASSETS × 100
 *   ROE         = PAT / (EQ_SHARE_CAP + RES_SURPLUS) × 100
 *   CAPEX       = ASSET_PPE + ASSET_CWIP
 *
 * Non-BFSI only:
 *   ROCE = (PBT + FIN_COST) / (TOTAL_ASSETS - CURR_LIAB) × 100
 *   FCF  = CFO - CAPEX
 *
 * BFSI only:
 *   FCF = CFO - CAPEX - PROV_CONT
 *
 * @param {Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value: number|null }>>} raw
 *   Output of getTimeSeriesBatch with SOURCE_ABBRS.
 * @param {boolean} [bfsi=false]
 * @returns {Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value: number|null, abbrUsed: string }>>}
 */
function computeDerivedKpis(raw, bfsi = false) {
  const anchor = raw['REV_OP'];
  if (!anchor.length) {
    return { EBIT: [], EBIT_MARGIN: [], ROCE: [], ROA: [], ROE: [], CAPEX: [], FCF: [] };
  }

  const ebit       = [];
  const ebitMargin = [];
  const roce       = [];
  const roa        = [];
  const roe        = [];
  const capex      = [];
  const fcf        = [];

  for (let i = 0; i < anchor.length; i++) {
    const base = {
      callId:      anchor[i].callId,
      period:      anchor[i].period,
      fiscal_year: anchor[i].fiscal_year,
      quarter:     anchor[i].quarter,
      call_date:   anchor[i].call_date,
    };
    const v = abbr => raw[abbr][i].value;

    // EBIT (non-BFSI) / PPOP (BFSI)
    let ebitVal;
    if (bfsi) {
      ebitVal = derive(
        [v('REV_OP'), v('EMP_EXP'), v('DEP_AMORT'), v('OTH_EXP')],
        ([rev, emp, dep, oth]) => rev - emp - dep - oth,
      );
    } else {
      // COGS components (COST_MAT, PURCH_STOCK, INV_CHG) are null for service companies
      // — treat as 0 so EBIT can still be computed from operating expenses
      const mat = v('COST_MAT') ?? 0;
      const pur = v('PURCH_STOCK') ?? 0;
      const chg = v('INV_CHG') ?? 0;
      ebitVal = derive(
        [v('REV_OP'), v('EMP_EXP'), v('DEP_AMORT'), v('OTH_EXP')],
        ([rev, emp, dep, oth]) => rev - mat - pur - chg - emp - dep - oth,
      );
    }
    ebit.push({ ...base, value: ebitVal, abbrUsed: bfsi ? 'PPOP' : 'EBIT' });

    // EBIT_MARGIN = EBIT / REV_OP × 100
    const ebitMarginVal = derive(
      [ebitVal, v('REV_OP')],
      ([eb, rev]) => rev === 0 ? null : (eb / rev) * 100,
    );
    ebitMargin.push({ ...base, value: ebitMarginVal, abbrUsed: 'EBIT_MARGIN' });

    // ROCE — non-BFSI only
    if (!bfsi) {
      const roceVal = derive(
        [v('PBT'), v('FIN_COST'), v('TOTAL_ASSETS'), v('CURR_LIAB')],
        ([pbt, fin, ta, cl]) => {
          const ce = ta - cl;
          return ce === 0 ? null : ((pbt + fin) / ce) * 100;
        },
      );
      roce.push({ ...base, value: roceVal, abbrUsed: 'ROCE' });
    } else {
      roce.push({ ...base, value: null, abbrUsed: 'ROCE' });
    }

    // ROA = PAT / TOTAL_ASSETS × 100
    const roaVal = derive(
      [v('PAT'), v('TOTAL_ASSETS')],
      ([pat, ta]) => ta === 0 ? null : (pat / ta) * 100,
    );
    roa.push({ ...base, value: roaVal, abbrUsed: 'ROA' });

    // ROE = PAT / (EQ_SHARE_CAP + RES_SURPLUS) × 100
    const roeVal = derive(
      [v('PAT'), v('EQ_SHARE_CAP'), v('RES_SURPLUS')],
      ([pat, eq, res]) => {
        const equity = eq + res;
        return equity === 0 ? null : (pat / equity) * 100;
      },
    );
    roe.push({ ...base, value: roeVal, abbrUsed: 'ROE' });

    // CAPEX = delta gross PPE (ASSET_LAND_GRS + ASSET_PM_GRS), computed in service when multi-year data available
    capex.push({ ...base, value: null, abbrUsed: 'CAPEX' });

    // FCF depends on CAPEX which is computed externally (delta gross PPE); set null here
    fcf.push({ ...base, value: null, abbrUsed: 'FCF' });
  }

  return { EBIT: ebit, EBIT_MARGIN: ebitMargin, ROCE: roce, ROA: roa, ROE: roe, CAPEX: capex, FCF: fcf };
}

module.exports = { SOURCE_ABBRS, computeDerivedKpis };
