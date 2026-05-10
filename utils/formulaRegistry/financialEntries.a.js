'use strict';

// Entries whose compute() functions do NOT reference REGISTRY or internal resolvers.
// EBITDA_MARGIN, EBIT_MARGIN, NET_DEBT_EBITDA, CFO_EBITDA_PCT, CASH_CONVERSION stay in financial.js.

module.exports = [

  // ── Income statement — formula ──────────────────────────────────────────────

  {
    id: 'EBITDA',
    computationType: 'formula',
    name:    'EBITDA',
    desc:    'Earnings Before Interest, Tax, Depreciation & Amortisation',
    unit:    'Cr',
    formula: 'PBT + FIN_COST + DEP_AMORT',
    inputs:  ['PBT', 'FIN_COST', 'DEP_AMORT'],
    compute(m) {
      const { PBT: pbt, FIN_COST: fc, DEP_AMORT: da } = m;
      if (pbt == null || fc == null || da == null) return null;
      return pbt + fc + da;
    },
  },

  {
    id: 'EBIT',
    computationType: 'formula',
    name:    'EBIT / PPOP',
    desc:    'Non-BFSI: PBT + Interest.  BFSI: Pre-Provisioning Operating Profit (PPOP) = REV_OP − EMP_EXP − OTH_EXP − DEP_AMORT',
    unit:    'Cr',
    formula: {
      standard: 'PBT + FIN_COST',
      bfsi:     'REV_OP − EMP_EXP − OTH_EXP − DEP_AMORT  (PPOP)',
    },
    inputs: {
      standard: ['PBT', 'FIN_COST'],
      bfsi:     ['REV_OP', 'EMP_EXP', 'OTH_EXP', 'DEP_AMORT'],
    },
    compute(m, { bfsi } = {}) {
      if (bfsi) {
        if (m.REV_OP == null || m.EMP_EXP == null || m.OTH_EXP == null || m.DEP_AMORT == null) return null;
        return m.REV_OP - m.EMP_EXP - m.OTH_EXP - m.DEP_AMORT;
      }
      if (m.PBT == null || m.FIN_COST == null) return null;
      return m.PBT + m.FIN_COST;
    },
  },

  {
    id: 'PROFIT_MARGIN',
    computationType: 'formula',
    name:    'Net Profit Margin',
    unit:    '%',
    formula: 'PAT / REV_OP × 100',
    inputs:  ['PAT', 'REV_OP'],
    compute(m) {
      const rev = m.REV_OP ?? m.TOTAL_INCOME;
      if (m.PAT == null || !rev) return null;
      return (m.PAT / rev) * 100;
    },
  },

  {
    id: 'GROSS_MARGIN',
    computationType: 'formula',
    name:    'Gross Profit Margin',
    unit:    '%',
    formula: '(TOTAL_INCOME − TOTAL_COGS) / REV_OP × 100',
    inputs:  ['TOTAL_INCOME', 'TOTAL_COGS', 'REV_OP'],
    compute(m) {
      const rev = m.REV_OP ?? m.TOTAL_INCOME;
      if (m.TOTAL_INCOME == null || m.TOTAL_COGS == null || !rev) return null;
      return ((m.TOTAL_INCOME - m.TOTAL_COGS) / rev) * 100;
    },
  },

  {
    id: 'OP_MARGIN',
    computationType: 'formula',
    name:    'Operating Margin',
    unit:    '%',
    formula: '(REV_OP − TOTAL_OPEX) / REV_OP × 100',
    inputs:  ['REV_OP', 'TOTAL_OPEX'],
    compute(m) {
      const rev = m.REV_OP ?? m.TOTAL_INCOME;
      if (!rev || m.TOTAL_OPEX == null) return null;
      return ((rev - m.TOTAL_OPEX) / rev) * 100;
    },
  },

  // ── Returns — formula ───────────────────────────────────────────────────────

  {
    id: 'ROCE',
    computationType: 'formula',
    name:    'Return on Capital Employed',
    unit:    '%',
    formula: '(PBT + FIN_COST) / (TOTAL_ASSETS − CURR_LIAB) × 100',
    inputs:  ['PBT', 'FIN_COST', 'TOTAL_ASSETS', 'CURR_LIAB'],
    compute(m) {
      const { PBT: pbt, FIN_COST: fc, TOTAL_ASSETS: ta, CURR_LIAB: cl } = m;
      if (pbt == null || fc == null || ta == null || cl == null) return null;
      const ce = ta - cl;
      return ce === 0 ? null : ((pbt + fc) / ce) * 100;
    },
  },

  {
    id: 'ROE',
    computationType: 'formula',
    name:    'Return on Equity',
    unit:    '%',
    formula: 'PAT / NET_WORTH × 100',
    inputs:  ['PAT', 'NET_WORTH'],
    compute(m) {
      const nw = m.NET_WORTH ?? (
        m.EQ_SHARE_CAP != null && m.RES_SURPLUS != null
          ? m.EQ_SHARE_CAP + m.RES_SURPLUS
          : null
      );
      if (m.PAT == null || nw == null || nw === 0) return null;
      return (m.PAT / nw) * 100;
    },
  },

  {
    id: 'ROA',
    computationType: 'formula',
    name:    'Return on Assets',
    unit:    '%',
    formula: 'PAT / TOTAL_ASSETS × 100',
    inputs:  ['PAT', 'TOTAL_ASSETS'],
    compute(m) {
      const { PAT: pat, TOTAL_ASSETS: ta } = m;
      if (pat == null || ta == null || ta === 0) return null;
      return (pat / ta) * 100;
    },
  },

  // ── Balance sheet — formula (stored, with fallback computation) ─────────────

  {
    id: 'NET_WORTH',
    computationType: 'formula',
    name:    'Net Worth / Shareholders Equity',
    desc:    'Stored directly, or derived as EQ_SHARE_CAP + RES_SURPLUS',
    unit:    'Cr',
    formula: 'EQ_SHARE_CAP + RES_SURPLUS',
    inputs:  ['EQ_SHARE_CAP', 'RES_SURPLUS'],
    compute(m) {
      if (m.NET_WORTH != null) return m.NET_WORTH;
      if (m.EQ_SHARE_CAP != null && m.RES_SURPLUS != null) return m.EQ_SHARE_CAP + m.RES_SURPLUS;
      return null;
    },
  },

  {
    id: 'BORR_TOTAL',
    computationType: 'formula',
    name:    'Total Borrowings',
    desc:    'Stored directly, or derived as DEBT_LT + DEBT_ST',
    unit:    'Cr',
    formula: 'DEBT_LT + DEBT_ST',
    inputs:  ['DEBT_LT', 'DEBT_ST'],
    compute(m) {
      if (m.BORR_TOTAL != null) return m.BORR_TOTAL;
      if (m.DEBT_LT != null || m.DEBT_ST != null) return (m.DEBT_LT ?? 0) + (m.DEBT_ST ?? 0);
      return null;
    },
  },

  // ── Balance sheet — raw stored KPIs ────────────────────────────────────────

  { id: 'EQ_SHARE_CAP',  computationType: 'raw', name: 'Equity Share Capital',    unit: 'Cr' },
  { id: 'RES_SURPLUS',   computationType: 'raw', name: 'Reserves & Surplus',       unit: 'Cr' },
  { id: 'TOTAL_LIAB',    computationType: 'raw', name: 'Total Liabilities',        unit: 'Cr' },
  { id: 'CURR_LIAB',     computationType: 'raw', name: 'Current Liabilities',      unit: 'Cr' },
  { id: 'CURR_ASSETS',   computationType: 'raw', name: 'Current Assets',           unit: 'Cr' },
  { id: 'INVENTORY',     computationType: 'raw', name: 'Inventory',                unit: 'Cr' },
  { id: 'CASH_EQUIV',    computationType: 'raw', name: 'Cash & Cash Equivalents',  unit: 'Cr' },
  { id: 'ASSET_PPE',     computationType: 'raw', name: 'Fixed Assets (PPE)',       unit: 'Cr' },
  { id: 'ASSET_CWIP',    computationType: 'raw', name: 'Capital Work-in-Progress', unit: 'Cr' },
  { id: 'INV_NONCURR',   computationType: 'raw', name: 'Non-current Investments',  unit: 'Cr' },
  { id: 'TOTAL_ASSETS',  computationType: 'raw', name: 'Total Assets',             unit: 'Cr' },
  { id: 'DEBT_LT',       computationType: 'raw', name: 'Long-term Debt',           unit: 'Cr' },
  { id: 'DEBT_ST',       computationType: 'raw', name: 'Short-term Debt',          unit: 'Cr' },

  // ── Income statement — raw stored KPIs ─────────────────────────────────────

  { id: 'REV_OP',       computationType: 'raw', name: 'Revenue from Operations',       unit: 'Cr' },
  { id: 'TOTAL_INCOME', computationType: 'raw', name: 'Total Income',                  unit: 'Cr' },
  { id: 'TOTAL_OPEX',   computationType: 'raw', name: 'Total Operating Expenses',      unit: 'Cr' },
  { id: 'TOTAL_COGS',   computationType: 'raw', name: 'Cost of Goods Sold',            unit: 'Cr' },
  { id: 'OTH_INC',      computationType: 'raw', name: 'Other Income',                  unit: 'Cr' },
  { id: 'FIN_COST',     computationType: 'raw', name: 'Finance Costs (Interest)',       unit: 'Cr' },
  { id: 'DEP_AMORT',    computationType: 'raw', name: 'Depreciation & Amortisation',   unit: 'Cr' },
  { id: 'TAX_EXP',      computationType: 'raw', name: 'Tax Expense',                   unit: 'Cr' },
  { id: 'PBT',          computationType: 'raw', name: 'Profit Before Tax',             unit: 'Cr' },
  { id: 'PAT',          computationType: 'raw', name: 'Profit After Tax',              unit: 'Cr' },
  { id: 'EPS_BASIC',    computationType: 'raw', name: 'Basic EPS',                     unit: '₹'  },
  { id: 'EPS_DILUTED',  computationType: 'raw', name: 'Diluted EPS',                   unit: '₹'  },

  // ── Cash flow — raw stored KPIs ────────────────────────────────────────────

  { id: 'CFO', computationType: 'raw', name: 'Cash from Operations', unit: 'Cr' },
  { id: 'CFI', computationType: 'raw', name: 'Cash from Investing',  unit: 'Cr' },
  { id: 'CFF', computationType: 'raw', name: 'Cash from Financing',  unit: 'Cr' },

  // ── Leverage — formula ──────────────────────────────────────────────────────

  {
    id: 'DE',
    computationType: 'formula',
    name:    'Debt-to-Equity',
    unit:    'x',
    formula: 'BORR_TOTAL / NET_WORTH',
    inputs:  ['BORR_TOTAL', 'NET_WORTH'],
    compute(m) {
      const debt = m.BORR_TOTAL ?? (
        m.DEBT_LT != null || m.DEBT_ST != null
          ? (m.DEBT_LT ?? 0) + (m.DEBT_ST ?? 0)
          : null
      );
      const nw = m.NET_WORTH ?? (
        m.EQ_SHARE_CAP != null && m.RES_SURPLUS != null
          ? m.EQ_SHARE_CAP + m.RES_SURPLUS
          : null
      );
      if (debt == null || nw == null || nw === 0) return null;
      return debt / nw;
    },
  },

  {
    id: 'NET_DEBT',
    computationType: 'formula',
    name:    'Net Debt',
    unit:    'Cr',
    formula: 'BORR_TOTAL − CASH_EQUIV',
    inputs:  ['BORR_TOTAL', 'CASH_EQUIV'],
    compute(m) {
      const debt = m.BORR_TOTAL ?? (
        m.DEBT_LT != null || m.DEBT_ST != null
          ? (m.DEBT_LT ?? 0) + (m.DEBT_ST ?? 0)
          : null
      );
      if (debt == null) return null;
      return debt - (m.CASH_EQUIV ?? 0);
    },
  },
];
