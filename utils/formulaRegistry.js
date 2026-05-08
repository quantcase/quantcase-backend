'use strict';

/**
 * Global metric registry — single source of truth for every computed indicator.
 *
 * Computation types:
 *   'formula'  — single-period: compute(kpiMap) → number|null
 *   'cagr'     — time-series:  CAGR from first → last non-null value in series
 *   'average'  — time-series:  arithmetic mean over a window of periods
 *   'delta'    — two-period:   compute(currKpiMap, prevKpiMap) → number|null
 *
 * resolveMetric(id, context) is the single enforcement point for all types.
 * resolveKpi(abbr, kpiMap)   is a backward-compatible alias for 'formula' type.
 *
 * Admin provenance — every resolved result carries:
 *   formula    — human-readable expression
 *   inputs     — abbr names of constituent KPIs
 *   inputValues / seriesUsed / periods  — actual values used (type-specific)
 */

const REGISTRY = {};

function def(id, meta) {
  REGISTRY[id] = { id, ...meta };
}

// ── Income statement — formula ────────────────────────────────────────────────

def('EBITDA', {
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
});

def('EBIT', {
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
});

def('EBITDA_MARGIN', {
  computationType: 'formula',
  name:    'EBITDA Margin',
  unit:    '%',
  formula: '(PBT + FIN_COST + DEP_AMORT) / REV_OP × 100',
  inputs:  ['PBT', 'FIN_COST', 'DEP_AMORT', 'REV_OP'],
  compute(m) {
    const rev    = m.REV_OP ?? m.TOTAL_INCOME;
    const ebitda = m.EBITDA ?? REGISTRY.EBITDA.compute(m);
    if (ebitda == null || !rev) return null;
    return (ebitda / rev) * 100;
  },
});

def('EBIT_MARGIN', {
  computationType: 'formula',
  name:    'EBIT Margin / PPOP Margin',
  unit:    '%',
  formula: {
    standard: '(PBT + FIN_COST) / REV_OP × 100',
    bfsi:     '(REV_OP − EMP_EXP − OTH_EXP − DEP_AMORT) / REV_OP × 100',
  },
  inputs: {
    standard: ['PBT', 'FIN_COST', 'REV_OP'],
    bfsi:     ['REV_OP', 'EMP_EXP', 'OTH_EXP', 'DEP_AMORT'],
  },
  compute(m, context = {}) {
    const rev  = m.REV_OP ?? m.TOTAL_INCOME;
    const ebit = m.EBIT ?? REGISTRY.EBIT.compute(m, context);
    if (ebit == null || !rev) return null;
    return (ebit / rev) * 100;
  },
});

def('PROFIT_MARGIN', {
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
});

def('GROSS_MARGIN', {
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
});

def('OP_MARGIN', {
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
});

// ── Returns — formula ─────────────────────────────────────────────────────────

def('ROCE', {
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
});

def('ROE', {
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
});

def('ROA', {
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
});

// ── Balance sheet — formula (stored, with fallback computation) ───────────────

def('NET_WORTH', {
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
});

def('BORR_TOTAL', {
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
});

// ── Balance sheet — raw stored KPIs ──────────────────────────────────────────

def('EQ_SHARE_CAP',  { computationType: 'raw', name: 'Equity Share Capital',    unit: 'Cr' });
def('RES_SURPLUS',   { computationType: 'raw', name: 'Reserves & Surplus',       unit: 'Cr' });
def('TOTAL_LIAB',    { computationType: 'raw', name: 'Total Liabilities',        unit: 'Cr' });
def('CURR_LIAB',     { computationType: 'raw', name: 'Current Liabilities',      unit: 'Cr' });
def('CURR_ASSETS',   { computationType: 'raw', name: 'Current Assets',           unit: 'Cr' });
def('INVENTORY',     { computationType: 'raw', name: 'Inventory',                unit: 'Cr' });
def('CASH_EQUIV',    { computationType: 'raw', name: 'Cash & Cash Equivalents',  unit: 'Cr' });
def('ASSET_PPE',     { computationType: 'raw', name: 'Fixed Assets (PPE)',       unit: 'Cr' });
def('ASSET_CWIP',    { computationType: 'raw', name: 'Capital Work-in-Progress', unit: 'Cr' });
def('INV_NONCURR',   { computationType: 'raw', name: 'Non-current Investments',  unit: 'Cr' });
def('TOTAL_ASSETS',  { computationType: 'raw', name: 'Total Assets',             unit: 'Cr' });
def('DEBT_LT',       { computationType: 'raw', name: 'Long-term Debt',           unit: 'Cr' });
def('DEBT_ST',       { computationType: 'raw', name: 'Short-term Debt',          unit: 'Cr' });

// ── Income statement — raw stored KPIs ───────────────────────────────────────

def('REV_OP',      { computationType: 'raw', name: 'Revenue from Operations', unit: 'Cr' });
def('TOTAL_INCOME',{ computationType: 'raw', name: 'Total Income',            unit: 'Cr' });
def('TOTAL_OPEX',  { computationType: 'raw', name: 'Total Operating Expenses',unit: 'Cr' });
def('TOTAL_COGS',  { computationType: 'raw', name: 'Cost of Goods Sold',      unit: 'Cr' });
def('OTH_INC',     { computationType: 'raw', name: 'Other Income',            unit: 'Cr' });
def('FIN_COST',    { computationType: 'raw', name: 'Finance Costs (Interest)',unit: 'Cr' });
def('DEP_AMORT',   { computationType: 'raw', name: 'Depreciation & Amortisation', unit: 'Cr' });
def('TAX_EXP',     { computationType: 'raw', name: 'Tax Expense',             unit: 'Cr' });
def('PBT',         { computationType: 'raw', name: 'Profit Before Tax',       unit: 'Cr' });
def('PAT',         { computationType: 'raw', name: 'Profit After Tax',        unit: 'Cr' });
def('EPS_BASIC',   { computationType: 'raw', name: 'Basic EPS',               unit: '₹'  });
def('EPS_DILUTED', { computationType: 'raw', name: 'Diluted EPS',             unit: '₹'  });

// ── Cash flow — raw stored KPIs ───────────────────────────────────────────────

def('CFO', { computationType: 'raw', name: 'Cash from Operations', unit: 'Cr' });
def('CFI', { computationType: 'raw', name: 'Cash from Investing',  unit: 'Cr' });
def('CFF', { computationType: 'raw', name: 'Cash from Financing',  unit: 'Cr' });

// ── Leverage — formula ────────────────────────────────────────────────────────

def('DE', {
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
});

def('NET_DEBT', {
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
});

def('NET_DEBT_EBITDA', {
  computationType: 'formula',
  name:    'Net Debt / EBITDA',
  unit:    'x',
  formula: 'NET_DEBT / EBITDA',
  inputs:  ['NET_DEBT', 'EBITDA'],
  compute(m) {
    const nd     = m.NET_DEBT ?? REGISTRY.NET_DEBT.compute(m);
    const ebitda = m.EBITDA   ?? REGISTRY.EBITDA.compute(m);
    if (nd == null || ebitda == null || ebitda === 0) return null;
    return nd / ebitda;
  },
});

// ── Liquidity — formula ───────────────────────────────────────────────────────

def('CURRENT_RATIO', {
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
});

def('QUICK_RATIO', {
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
});

// ── Capital expenditure — delta ───────────────────────────────────────────────

def('CAPEX', {
  computationType: 'delta',
  name:    'Capital Expenditure',
  desc:    'Net additions to gross PPE and net standalone asset components across consecutive periods',
  unit:    'Cr',
  formula: 'Δ(ASSET_LAND_GRS + ASSET_PM_GRS) + Δ(ASSET_MINING_NET + ASSET_BIO_NET + ASSET_LEASE_IMP_NET + ASSET_TRANS_NET + ASSET_FURN_NET + ASSET_CWIP)',
  inputs:  ['ASSET_LAND_GRS', 'ASSET_PM_GRS', 'ASSET_MINING_NET', 'ASSET_BIO_NET',
            'ASSET_LEASE_IMP_NET', 'ASSET_TRANS_NET', 'ASSET_FURN_NET', 'ASSET_CWIP'],
  // compute(curr, prev): called by _resolveDelta with two kpiMaps
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
});

// ── Cash flow — formula ───────────────────────────────────────────────────────

def('FCF', {
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
});

// ── Gross profit — formula ────────────────────────────────────────────────────

def('GROSS_PROFIT', {
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
});

// ── Cash quality — formula ────────────────────────────────────────────────────

def('CFO_EBITDA_PCT', {
  computationType: 'formula',
  name:    'CFO / EBITDA %',
  desc:    'Cash conversion quality — what fraction of EBITDA becomes operating cash flow',
  unit:    '%',
  formula: 'CFO / EBITDA × 100',
  inputs:  ['CFO', 'EBITDA'],
  compute(m) {
    const ebitda = m.EBITDA ?? REGISTRY.EBITDA.compute(m);
    if (m.CFO == null || ebitda == null || ebitda === 0) return null;
    return (m.CFO / ebitda) * 100;
  },
});

def('CASH_CONVERSION', {
  computationType: 'formula',
  name:    'Cash Conversion',
  desc:    'FCF as a percentage of PAT — measures how much reported profit converts to free cash',
  unit:    '%',
  formula: 'FCF / PAT × 100',
  inputs:  ['FCF', 'PAT'],
  compute(m, context = {}) {
    // FCF is itself a formula metric whose CAPEX input is delta-resolved via prevKpiMap.
    // If FCF was pre-injected into m (e.g. by the caller), use it directly; otherwise
    // fall back to _resolveFormula which will auto-resolve the CAPEX delta internally.
    const fcf = m.FCF != null ? m.FCF : _resolveFormula(REGISTRY.FCF, m, context).value;
    if (fcf == null || m.PAT == null || m.PAT === 0) return null;
    return (fcf / m.PAT) * 100;
  },
});

// ── Growth — cagr ─────────────────────────────────────────────────────────────

def('EPS_CAGR', {
  computationType: 'cagr',
  name:    'EPS CAGR',
  unit:    '%',
  formula: 'CAGR(EPS_BASIC, first → last annual period)',
  inputs:  ['EPS_BASIC'],
});

def('EPS_CAGR_3Y', {
  computationType: 'cagr',
  name:          'EPS 3-year CAGR',
  unit:          '%',
  formula:       'CAGR(EPS_BASIC, last 3 annual periods)',
  inputs:        ['EPS_BASIC'],
  defaultWindow: 3,
});

def('REV_CAGR', {
  computationType: 'cagr',
  name:    'Revenue CAGR',
  unit:    '%',
  formula: 'CAGR(REV_OP, first → last annual period)',
  inputs:  ['REV_OP'],
});

def('REV_CAGR_3Y', {
  computationType: 'cagr',
  name:          'Revenue 3-year CAGR',
  unit:          '%',
  formula:       'CAGR(REV_OP, last 3 annual periods)',
  inputs:        ['REV_OP'],
  defaultWindow: 3,
});

def('REV_CAGR_5Y', {
  computationType: 'cagr',
  name:          'Revenue 5-year CAGR',
  unit:          '%',
  formula:       'CAGR(REV_OP, last 5 annual periods)',
  inputs:        ['REV_OP'],
  defaultWindow: 5,
});

def('REV_CAGR_10Y', {
  computationType: 'cagr',
  name:          'Revenue 10-year CAGR',
  unit:          '%',
  formula:       'CAGR(REV_OP, last 10 annual periods)',
  inputs:        ['REV_OP'],
  defaultWindow: 10,
});

def('PAT_CAGR', {
  computationType: 'cagr',
  name:    'PAT CAGR',
  unit:    '%',
  formula: 'CAGR(PAT, first → last annual period)',
  inputs:  ['PAT'],
});

def('PAT_CAGR_3Y', {
  computationType: 'cagr',
  name:          'PAT 3-year CAGR',
  unit:          '%',
  formula:       'CAGR(PAT, last 3 annual periods)',
  inputs:        ['PAT'],
  defaultWindow: 3,
});

def('PAT_CAGR_10Y', {
  computationType: 'cagr',
  name:          'PAT 10-year CAGR',
  unit:          '%',
  formula:       'CAGR(PAT, last 10 annual periods)',
  inputs:        ['PAT'],
  defaultWindow: 10,
});

// ── Multi-period averages — average ───────────────────────────────────────────

def('ROCE_3Y_AVG', {
  computationType: 'average',
  name:          'ROCE 3-year Average',
  unit:          '%',
  formula:       'avg(ROCE, last 3 annual periods)',
  inputs:        ['ROCE'],
  defaultWindow: 3,
});

def('ROE_3Y_AVG', {
  computationType: 'average',
  name:          'ROE 3-year Average',
  unit:          '%',
  formula:       'avg(ROE, last 3 annual periods)',
  inputs:        ['ROE'],
  defaultWindow: 3,
});

def('ROE_5Y_AVG', {
  computationType: 'average',
  name:          'ROE 5-year Average',
  unit:          '%',
  formula:       'avg(ROE, last 5 annual periods)',
  inputs:        ['ROE'],
  defaultWindow: 5,
});

def('ROE_10Y_AVG', {
  computationType: 'average',
  name:          'ROE 10-year Average',
  unit:          '%',
  formula:       'avg(ROE, last 10 annual periods)',
  inputs:        ['ROE'],
  defaultWindow: 10,
});

// ── Resolution internals ──────────────────────────────────────────────────────

function _resolveRaw(entry, kpiMap) {
  const val = kpiMap[entry.id] ?? null;
  return {
    value:  val,
    source: val != null ? 'stored' : 'no_data',
    name:   entry.name,
  };
}

function _resolveFormula(entry, kpiMap, context = {}) {
  const { bfsi = false, prevKpiMap = null } = context;
  const stored = kpiMap[entry.id];
  if (stored != null) return { value: stored, source: 'stored' };

  // Pick the bfsi variant when the entry declares one, otherwise use the single definition
  const formula = entry.formula?.bfsi != null
    ? (bfsi ? entry.formula.bfsi : entry.formula.standard)
    : entry.formula;
  const inputs  = Array.isArray(entry.inputs)
    ? entry.inputs
    : (bfsi && entry.inputs.bfsi ? entry.inputs.bfsi : entry.inputs.standard);

  // Auto-resolve any delta-type inputs that are missing from kpiMap.
  // This lets formulas like FCF use CAPEX without the caller pre-injecting it —
  // as long as prevKpiMap is in context, the registry resolves it internally.
  let resolvedMap = kpiMap;
  if (prevKpiMap) {
    const deltaDeps = inputs.filter(a => kpiMap[a] == null && REGISTRY[a]?.computationType === 'delta');
    if (deltaDeps.length) {
      resolvedMap = { ...kpiMap };
      for (const abbr of deltaDeps) {
        const depRes = _resolveDelta(REGISTRY[abbr], kpiMap, prevKpiMap);
        if (depRes.value != null) resolvedMap[abbr] = depRes.value;
      }
    }
  }

  const computed    = entry.compute(resolvedMap, context);
  const inputValues = Object.fromEntries(inputs.map(a => [a, resolvedMap[a] ?? null]));
  return {
    value:       computed,
    source:      computed != null ? 'computed' : 'computed_null',
    formula,
    inputs,
    inputValues,
    name:        entry.name,
  };
}

function _resolveCagr(entry, series, windowSize) {
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  if (!series || !series.length) return { value: null, source: 'no_data', ...base };

  const allPts = series.filter(s => s.value != null);
  if (!allPts.length) return { value: null, source: 'computed_null', ...base };

  // For a W-year windowed CAGR we need W+1 data points (base year + W annual periods).
  const w   = windowSize ?? entry.defaultWindow ?? null;
  const pts = w != null ? allPts.slice(-(w + 1)) : allPts;

  const first = pts[0], last = pts.at(-1);
  const spanYears = pts.length - 1;

  if (pts.length === 1) {
    return { value: last.value, source: 'computed', ...base,
             seriesUsed: pts, spanYears: 0, window: w,
             note: 'Only one period — returning latest' };
  }
  if (first.value == null || first.value <= 0) {
    return { value: last.value, source: 'computed', ...base,
             seriesUsed: [first, last], spanYears, window: w,
             note: 'Non-positive base — returning latest' };
  }

  const cagrVal = (Math.pow(Math.abs(last.value) / first.value, 1 / spanYears) - 1)
                  * 100 * Math.sign(last.value);
  return {
    value:      parseFloat(cagrVal.toFixed(2)),
    source:     'computed',
    ...base,
    seriesUsed: [first, last],
    allPeriods: pts,
    spanYears,
    window:     w,
  };
}

function _resolveAverage(entry, series, windowSize) {
  const w    = windowSize ?? entry.defaultWindow ?? null;
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  if (!series || !series.length) return { value: null, source: 'no_data', ...base };

  const pts     = series.filter(s => s.value != null);
  const periods = w != null ? pts.slice(-w) : pts;
  if (!periods.length) return { value: null, source: 'computed_null', ...base };

  const avg = periods.reduce((s, p) => s + p.value, 0) / periods.length;
  return {
    value:      parseFloat(avg.toFixed(2)),
    source:     'computed',
    ...base,
    periods,
    windowSize: periods.length,
  };
}

function _resolveDelta(entry, kpiMap, prevKpiMap) {
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  const stored = kpiMap[entry.id];
  if (stored != null) return { value: stored, source: 'stored' };
  if (!prevKpiMap) return { value: null, source: 'no_data', ...base };

  const computed = entry.compute(kpiMap, prevKpiMap);

  // Per-input: show curr, prev, and Δ so admin can verify each component
  const inputValues = {};
  for (const abbr of entry.inputs) {
    const c = kpiMap[abbr]     ?? null;
    const p = prevKpiMap[abbr] ?? null;
    inputValues[abbr] = { curr: c, prev: p, delta: c != null && p != null ? c - p : null };
  }

  return {
    value:       computed,
    source:      computed != null ? 'computed' : 'computed_null',
    ...base,
    inputValues,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Universal resolution — single enforcement point for all metric types.
 *
 * @param {string} id
 * @param {object} context
 * @param {Record<string,number>}             [context.kpiMap]     Current-period flat map
 * @param {Record<string,number>}             [context.prevKpiMap] Previous-period map (delta type)
 * @param {Array<{period,fiscal_year,value}>} [context.series]     Ordered time-series (cagr/average)
 * @param {number}                            [context.window]     Window override (average type)
 * @param {boolean}                           [context.bfsi]       Use BFSI variant formula where available
 */
function resolveMetric(id, context = {}) {
  const { kpiMap = {}, prevKpiMap = null, series = null, window: windowSize = null } = context;
  const entry = REGISTRY[id];
  if (!entry) return { value: null, source: 'no_data' };

  switch (entry.computationType) {
    case 'raw':     return _resolveRaw(entry, kpiMap);
    case 'formula': return _resolveFormula(entry, kpiMap, context);
    case 'cagr':    return _resolveCagr(entry, series, windowSize);
    case 'average': return _resolveAverage(entry, series, windowSize);
    case 'delta':   return _resolveDelta(entry, kpiMap, prevKpiMap);
    default:        return { value: null, source: 'no_data' };
  }
}

/**
 * Backward-compatible alias — formula type only.
 * Equivalent to resolveMetric(abbr, { kpiMap }).
 */
function resolveKpi(abbr, kpiMap) {
  return resolveMetric(abbr, { kpiMap });
}

module.exports = { REGISTRY, resolveMetric, resolveKpi };
