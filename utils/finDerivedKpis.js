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
  'CFO', 'PROV_CONT',
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

    // CAPEX = ASSET_PPE + ASSET_CWIP (CWIP may be null for BFSI — treat as 0)
    const capexVal = derive(
      [v('ASSET_PPE')],
      ([ppe]) => ppe + (v('ASSET_CWIP') ?? 0),
    );
    capex.push({ ...base, value: capexVal, abbrUsed: 'CAPEX' });

    // FCF: non-BFSI = CFO - CAPEX; BFSI = CFO - CAPEX - PROV_CONT
    let fcfVal;
    if (bfsi) {
      fcfVal = derive(
        [v('CFO'), capexVal],
        ([cfo, cap]) => cfo - cap - (v('PROV_CONT') ?? 0),
      );
    } else {
      fcfVal = derive(
        [v('CFO'), capexVal],
        ([cfo, cap]) => cfo - cap,
      );
    }
    fcf.push({ ...base, value: fcfVal, abbrUsed: 'FCF' });
  }

  return { EBIT: ebit, EBIT_MARGIN: ebitMargin, ROCE: roce, ROA: roa, ROE: roe, CAPEX: capex, FCF: fcf };
}

module.exports = { SOURCE_ABBRS, computeDerivedKpis };
