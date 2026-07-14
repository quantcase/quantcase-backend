'use strict';

// Entries whose compute() functions do NOT reference REGISTRY or internal resolvers.
// NET_DEBT_EBITDA, CFO_EBITDA_PCT, CASH_CONVERSION stay in financial.js.

module.exports = [

  // ── Liquidity — formula ─────────────────────────────────────────────────────

  {
    id: 'CURRENT_RATIO',
    computationType: 'formula',
    name:    'Current Ratio',
    unit:    'x',
    formula: 'CURR_ASSETS / CURR_LIAB',
    inputs:  ['CURR_ASSETS', 'CURR_LIAB'],
    compute(m) {
      const { CURR_ASSETS: ca, CURR_LIAB: cl } = m;
      if (ca == null || cl == null || cl === 0) return null;
      return ca / cl;
    },
  },

  {
    id: 'QUICK_RATIO',
    computationType: 'formula',
    name:    'Quick Ratio',
    unit:    'x',
    formula: '(CURR_ASSETS − INVENTORY) / CURR_LIAB',
    inputs:  ['CURR_ASSETS', 'INVENTORY', 'CURR_LIAB'],
    compute(m) {
      const { CURR_ASSETS: ca, INVENTORY: inv, CURR_LIAB: cl } = m;
      if (ca == null || cl == null || cl === 0) return null;
      return (ca - (inv ?? 0)) / cl;
    },
  },

  // ── Capital expenditure — delta ─────────────────────────────────────────────

  {
    id: 'CAPEX',
    computationType: 'delta',
    name:    'Capital Expenditure',
    desc:    'Net additions to gross PPE and net standalone asset components across consecutive periods',
    unit:    'Cr',
    formula: 'Δ(ASSET_LAND_GRS + ASSET_PM_GRS) + Δ(ASSET_MINING_NET + ASSET_BIO_NET + ASSET_LEASE_IMP_NET + ASSET_TRANS_NET + ASSET_FURN_NET + ASSET_CWIP)',
    inputs:  ['ASSET_LAND_GRS', 'ASSET_PM_GRS', 'ASSET_MINING_NET', 'ASSET_BIO_NET',
              'ASSET_LEASE_IMP_NET', 'ASSET_TRANS_NET', 'ASSET_FURN_NET', 'ASSET_CWIP'],
    compute(curr, prev) {
      const d = abbr => {
        const c = curr[abbr], p = prev[abbr];
        return c != null && p != null ? c - p : null;
      };
      const dLand = d('ASSET_LAND_GRS');
      const dPm   = d('ASSET_PM_GRS');
      if (dLand == null && dPm == null) return null;
      const val = (dLand ?? 0) + (dPm ?? 0)
        + (d('ASSET_MINING_NET')    ?? 0)
        + (d('ASSET_BIO_NET')       ?? 0)
        + (d('ASSET_LEASE_IMP_NET') ?? 0)
        + (d('ASSET_TRANS_NET')     ?? 0)
        + (d('ASSET_FURN_NET')      ?? 0)
        + (d('ASSET_CWIP')          ?? 0);
      return Math.max(0, parseFloat(val.toFixed(2)));
    },
  },

  // ── Cash flow — formula ─────────────────────────────────────────────────────

  {
    id: 'FCF',
    computationType: 'formula',
    name:    'Free Cash Flow',
    desc:    'CFO − CAPEX.  CAPEX is a delta metric — prevKpiMap must be in context for it to resolve.  BFSI also deducts PROV_CONT.',
    unit:    'Cr',
    formula: {
      standard: 'CFO − CAPEX',
      bfsi:     'CFO − CAPEX − PROV_CONT',
    },
    inputs: {
      standard: ['CFO', 'CAPEX'],
      bfsi:     ['CFO', 'CAPEX', 'PROV_CONT'],
    },
    compute(m, { bfsi } = {}) {
      if (m.CFO == null || m.CAPEX == null) return null;
      return bfsi ? m.CFO - m.CAPEX - (m.PROV_CONT ?? 0) : m.CFO - m.CAPEX;
    },
  },

  // ── Gross profit — formula ──────────────────────────────────────────────────

  {
    id: 'GROSS_PROFIT',
    computationType: 'formula',
    name:    'Gross Profit',
    desc:    'Absolute gross profit (TOTAL_INCOME − TOTAL_COGS)',
    unit:    'Cr',
    formula: 'TOTAL_INCOME − TOTAL_COGS',
    inputs:  ['TOTAL_INCOME', 'TOTAL_COGS'],
    compute(m) {
      if (m.TOTAL_INCOME == null || m.TOTAL_COGS == null) return null;
      return m.TOTAL_INCOME - m.TOTAL_COGS;
    },
  },

  // ── Price-based ratios — formula ────────────────────────────────────────────
  // PRICE and TTM_* values are injected into kpiMap by callers from nse_equity_new.
  // EQ_SHARE_CAP is in Cr; shares = EQ_SHARE_CAP × 1e7 / 10 (face value ₹10).
  // MARKET_CAP_CR = PRICE × EQ_SHARE_CAP / 10  (all in Cr).

  {
    id: 'MARKET_CAP_CR',
    computationType: 'formula',
    name:    'Market Capitalisation',
    unit:    'Cr',
    formula: 'PRICE × EQ_SHARE_CAP / 10',
    inputs:  ['PRICE', 'EQ_SHARE_CAP'],
    compute(m) {
      if (m.PRICE == null || m.EQ_SHARE_CAP == null) return null;
      return m.PRICE * m.EQ_SHARE_CAP / 10;
    },
  },

  {
    id: 'PE_TTM',
    computationType: 'formula',
    name:    'PE Ratio (TTM)',
    unit:    'x',
    formula: 'PRICE / TTM_EPS',
    inputs:  ['PRICE', 'TTM_EPS'],
    compute(m) {
      if (m.PRICE == null || !m.TTM_EPS) return null;
      return m.PRICE / m.TTM_EPS;
    },
  },

  {
    id: 'EV_EBITDA_TTM',
    computationType: 'formula',
    name:    'EV / EBITDA (TTM)',
    unit:    'x',
    desc:    'EV = MARKET_CAP_CR + BORR_TOTAL − CASH_EQUIV; TTM_EBITDA pre-summed by caller',
    formula: '(PRICE × EQ_SHARE_CAP / 10 + BORR_TOTAL − CASH_EQUIV) / TTM_EBITDA',
    inputs:  ['PRICE', 'EQ_SHARE_CAP', 'BORR_TOTAL', 'CASH_EQUIV', 'TTM_EBITDA'],
    compute(m) {
      if (m.PRICE == null || m.EQ_SHARE_CAP == null || !m.TTM_EBITDA) return null;
      const ev = m.PRICE * m.EQ_SHARE_CAP / 10 + (m.BORR_TOTAL ?? 0) - (m.CASH_EQUIV ?? 0);
      return ev / m.TTM_EBITDA;
    },
  },

  {
    id: 'MC_SALES_TTM',
    computationType: 'formula',
    name:    'Market Cap / Sales (TTM)',
    unit:    'x',
    formula: '(PRICE × EQ_SHARE_CAP / 10) / TTM_REV',
    inputs:  ['PRICE', 'EQ_SHARE_CAP', 'TTM_REV'],
    compute(m) {
      if (m.PRICE == null || m.EQ_SHARE_CAP == null || !m.TTM_REV) return null;
      return (m.PRICE * m.EQ_SHARE_CAP / 10) / m.TTM_REV;
    },
  },

  {
    id: 'PB_TTM',
    computationType: 'formula',
    name:    'Price to Book Value',
    desc:    'MARKET_CAP_CR (from nse_equity_new, already in ₹ Cr) is compared against NET_WORTH (from prowess_values_new, raw ₹) — NET_WORTH is converted to Cr (÷1e7) before dividing so both sides are in the same unit.',
    unit:    'x',
    formula: 'MARKET_CAP_CR / (NET_WORTH / 1e7)',
    inputs:  ['MARKET_CAP_CR', 'EQ_SHARE_CAP', 'RES_SURPLUS'],
    compute(m) {
      const mc = m.MARKET_CAP_CR;
      const nwRaw = m.NET_WORTH ?? (m.EQ_SHARE_CAP != null && m.RES_SURPLUS != null ? m.EQ_SHARE_CAP + m.RES_SURPLUS : null);
      if (mc == null || !nwRaw) return null;
      return mc / (nwRaw / 1e7);
    },
  },

  {
    id: 'PEG_RATIO',
    computationType: 'formula',
    name:    'PEG Ratio',
    desc:    'PE / EPS growth rate.  EPS_GROWTH_PCT is injected into the kpiMap by the caller (typically resolveMetric(\'EPS_CAGR_3Y\', { series }).value).',
    unit:    'x',
    formula: 'PE_TTM / EPS_GROWTH_PCT',
    inputs:  ['PRICE', 'TTM_EPS', 'EPS_GROWTH_PCT'],
    compute(m) {
      const pe = m.PE_TTM ?? (m.PRICE != null && m.TTM_EPS ? m.PRICE / m.TTM_EPS : null);
      if (pe == null || !m.EPS_GROWTH_PCT || m.EPS_GROWTH_PCT <= 0) return null;
      return pe / m.EPS_GROWTH_PCT;
    },
  },

  {
    id: 'OCF_PAT',
    computationType: 'formula',
    name:    'OCF / PAT',
    desc:    'Cash conversion quality — what fraction of reported profit is backed by operating cash flow',
    unit:    'x',
    formula: 'CFO / PAT',
    inputs:  ['CFO', 'PAT'],
    compute(m) {
      if (m.CFO == null || !m.PAT) return null;
      return m.CFO / m.PAT;
    },
  },

  // ── Growth — cagr ───────────────────────────────────────────────────────────

  {
    id:              'EPS_CAGR',
    computationType: 'cagr',
    name:            'EPS CAGR',
    unit:            '%',
    formula:         'CAGR(EPS_BASIC, first → last annual period)',
    inputs:          ['EPS_BASIC'],
  },

  {
    id:              'EPS_CAGR_3Y',
    computationType: 'cagr',
    name:            'EPS 3-year CAGR',
    unit:            '%',
    formula:         'CAGR(EPS_BASIC, last 3 annual periods)',
    inputs:          ['EPS_BASIC'],
    defaultWindow:   3,
  },

  {
    id:              'EPS_CAGR_5Y',
    computationType: 'cagr',
    name:            'EPS 5-year CAGR',
    unit:            '%',
    formula:         'CAGR(EPS_BASIC, last 5 annual periods)',
    inputs:          ['EPS_BASIC'],
    defaultWindow:   5,
  },

  {
    id:              'REV_CAGR',
    computationType: 'cagr',
    name:            'Revenue CAGR',
    unit:            '%',
    formula:         'CAGR(REV_OP, first → last annual period)',
    inputs:          ['REV_OP'],
  },

  {
    id:              'REV_CAGR_3Y',
    computationType: 'cagr',
    name:            'Revenue 3-year CAGR',
    unit:            '%',
    formula:         'CAGR(REV_OP, last 3 annual periods)',
    inputs:          ['REV_OP'],
    defaultWindow:   3,
  },

  {
    id:              'REV_CAGR_5Y',
    computationType: 'cagr',
    name:            'Revenue 5-year CAGR',
    unit:            '%',
    formula:         'CAGR(REV_OP, last 5 annual periods)',
    inputs:          ['REV_OP'],
    defaultWindow:   5,
  },

  {
    id:              'REV_CAGR_10Y',
    computationType: 'cagr',
    name:            'Revenue 10-year CAGR',
    unit:            '%',
    formula:         'CAGR(REV_OP, last 10 annual periods)',
    inputs:          ['REV_OP'],
    defaultWindow:   10,
  },

  {
    id:              'PAT_CAGR',
    computationType: 'cagr',
    name:            'PAT CAGR',
    unit:            '%',
    formula:         'CAGR(PAT, first → last annual period)',
    inputs:          ['PAT'],
  },

  {
    id:              'PAT_CAGR_3Y',
    computationType: 'cagr',
    name:            'PAT 3-year CAGR',
    unit:            '%',
    formula:         'CAGR(PAT, last 3 annual periods)',
    inputs:          ['PAT'],
    defaultWindow:   3,
  },

  {
    id:              'PAT_CAGR_5Y',
    computationType: 'cagr',
    name:            'PAT 5-year CAGR',
    unit:            '%',
    formula:         'CAGR(PAT, last 5 annual periods)',
    inputs:          ['PAT'],
    defaultWindow:   5,
  },

  {
    id:              'PAT_CAGR_10Y',
    computationType: 'cagr',
    name:            'PAT 10-year CAGR',
    unit:            '%',
    formula:         'CAGR(PAT, last 10 annual periods)',
    inputs:          ['PAT'],
    defaultWindow:   10,
  },

  // ── Multi-period averages — average ─────────────────────────────────────────

  {
    id:              'ROCE_3Y_AVG',
    computationType: 'average',
    name:            'ROCE 3-year Average',
    unit:            '%',
    formula:         'avg(ROCE, last 3 annual periods)',
    inputs:          ['ROCE'],
    defaultWindow:   3,
  },

  {
    id:              'ROE_3Y_AVG',
    computationType: 'average',
    name:            'ROE 3-year Average',
    unit:            '%',
    formula:         'avg(ROE, last 3 annual periods)',
    inputs:          ['ROE'],
    defaultWindow:   3,
  },

  {
    id:              'ROE_5Y_AVG',
    computationType: 'average',
    name:            'ROE 5-year Average',
    unit:            '%',
    formula:         'avg(ROE, last 5 annual periods)',
    inputs:          ['ROE'],
    defaultWindow:   5,
  },

  {
    id:              'ROE_10Y_AVG',
    computationType: 'average',
    name:            'ROE 10-year Average',
    unit:            '%',
    formula:         'avg(ROE, last 10 annual periods)',
    inputs:          ['ROE'],
    defaultWindow:   10,
  },

  {
    id:              'HISTORICAL_PE_3Y',
    computationType: 'average',
    name:            'Historical PE — 3-year Average',
    desc:            'Caller builds the series as one point per calendar year (yearly-average PE from nse_equity_new), not raw daily/weekly rows — keeps this valid across the daily/weekly cadence change (see dataFetcherMarket.fetchPeTimeSeries).',
    unit:            'x',
    formula:         'avg(PE, one point per calendar year, last 3 years)',
    inputs:          ['PE_TTM'],
    defaultWindow:   3,
  },

  {
    id:              'HISTORICAL_PE_5Y',
    computationType: 'average',
    name:            'Historical PE — 5-year Average',
    desc:            'Caller builds the series as one point per calendar year (yearly-average PE from nse_equity_new), not raw daily/weekly rows — keeps this valid across the daily/weekly cadence change (see dataFetcherMarket.fetchPeTimeSeries).',
    unit:            'x',
    formula:         'avg(PE, one point per calendar year, last 5 years)',
    inputs:          ['PE_TTM'],
    defaultWindow:   5,
  },
];
