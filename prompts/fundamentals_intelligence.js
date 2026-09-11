'use strict';

const peerIdentity = require('../lib/peerIdentity');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function na(val) {
  return val != null && val !== '' ? val : 'N/A';
}

function pct(val) {
  if (val == null) return 'N/A';
  return `${val}%`;
}

function cr(val) {
  if (val == null) return 'N/A';
  return `${val} Cr`;
}

// ─── Data block builder ───────────────────────────────────────────────────────

function buildDataBlock(symbol, finResult) {
  const s = finResult?.standardized ?? {};

  // financials.analyze() returns sections partitioned by C (Consolidated) and S (Standalone).
  // Pick Consolidated if it carries data, otherwise fall back to Standalone.
  function pickStatement(sec) {
    if (!sec) return { periods: [], rows: [] };
    if (Array.isArray(sec.periods) || Array.isArray(sec.rows)) return sec;
    const primary = sec.C;
    const fallback = sec.S;
    if (primary && ((primary.periods?.length && primary.rows?.length) || primary.rows?.length)) return primary;
    if (fallback && ((fallback.periods?.length && fallback.rows?.length) || fallback.rows?.length)) return fallback;
    return primary ?? fallback ?? { periods: [], rows: [] };
  }

  function pickObj(obj) {
    if (!obj) return {};
    if (obj.C || obj.S) {
      const cHas = obj.C && Object.values(obj.C).some((v) => v != null);
      if (cHas) return obj.C;
      return obj.S ?? obj.C ?? {};
    }
    return obj;
  }

  const ttm = pickObj(s.ttm);
  const met = pickObj(s.metrics);
  const val = pickObj(s.valuation);
  const bs  = pickStatement(s.balanceSheet?.annual ?? s.balanceSheet);
  const cf  = pickStatement(s.cashFlow?.annual ?? s.cashFlow);
  const ann = pickStatement(s.annual);

  // financials.analyze() labels statement rows with KPI codes (REV_OP, CFO,
  // BORR_TOTAL, …), not camelCase names. Lookups take a candidate list because
  // the annual P&L row set varies by screen config — a plain P&L company
  // returns REV_OP/OP_PROFIT/PAT while BFSI returns T_INC_CON_OPR_BFSI/FIN_COST/
  // PROV_CONT/PAT — and a missing concept must degrade to N/A, not to a
  // wrong row.
  const ROW_KEYS = {
    revenue:         ['REV_OP', 'TOTAL_INCOME', 'T_INC_CON_OPR_BFSI', 'SALES_BFSI'],
    operatingProfit: ['OP_PROFIT', 'GROSS_PROFIT', 'PPOP'],
    opm:             ['OPM', 'NPM_PERCENT', 'NPM_ANNUAL_PCT', 'NIM_PCT'],
    netProfit:       ['PAT', 'NET_PNL_AFTR_SHAREPNL_ASST_BFSI', 'NET_PNL_CONTI_OPT_BFSI'],
    equityCapital:   ['EQ_SHARE_CAP', 'TOT_CAP', 'EQUITY_SHARE_CAP'],
    reserves:        ['RES_SURPLUS', 'RESERVES_SURPLUS'],
    borrowings:      ['BORR_TOTAL', 'TOT_BORROW', 'BORROWINGS'],
    totalAssets:     ['TOTAL_ASSETS', 'TOTAL_ASSETS_CALC'],
    fixedAssets:     ['ASSET_PPE', 'FIXED_ASST'],
    investments:     ['INV_NONCURR', 'TOT_INV', 'INVESTMENTS'],
    operatingCF:     ['CFO'],
    investingCF:     ['CFI'],
    financingCF:     ['CFF'],
    advances:        ['ADVANCE_BFSI', 'BFSI_LOAN_ADV'],
    deposits:        ['DEPOSIT_BFSI', 'DEP_COMM_BNK'],
    nim:             ['NIM_PCT', 'NIM_BFSI'],
    grossNpa:        ['GRS_NPA_PCT_ADV_BFSI'],
    netNpa:          ['NET_NPA_PCT_ADV_BFSI'],
  };

  function findRow(rows, concept) {
    const candidates = ROW_KEYS[concept] ?? [concept];
    return rows.find((r) => candidates.includes(r.key)) ?? null;
  }

  /**
   * Index of the latest period that actually carries data. The period list can
   * run ahead of what has been reported (a bank showing FY26 with every row
   * null, or with 0 placeholders in the total rows), and reading the trailing
   * index blindly renders a whole statement as N/A. Resolved once per statement
   * rather than per row so all figures in a block come from the same year —
   * otherwise D/E could mix FY25 equity with FY24 borrowings.
   *
   * Zero counts as unreported: no statement here has a legitimately all-zero
   * period, so an all-zero column is a placeholder, not a filing.
   */
  function lastReportedIdx(rows, periods) {
    for (let i = (periods ?? []).length - 1; i >= 0; i -= 1) {
      if (rows.some((r) => r.values?.[i] != null && r.values[i] !== 0)) return i;
    }
    return -1;
  }

  function valueAt(rows, concept, idx) {
    const row = findRow(rows, concept);
    if (!row || idx < 0) return null;
    return row.values[idx] ?? null;
  }

  function latestNonNull(rows, concept, maxIdx) {
    const row = findRow(rows, concept);
    if (!row?.values?.length) return null;
    const start = Math.min(maxIdx >= 0 ? maxIdx : row.values.length - 1, row.values.length - 1);
    for (let i = start; i >= 0; i -= 1) {
      if (row.values[i] != null && row.values[i] !== 0) return row.values[i];
    }
    return null;
  }

  const annPeriods = ann.periods ?? [];
  const annRows    = ann.rows    ?? [];
  const lastIdx    = lastReportedIdx(annRows, annPeriods);

  function annVal(concept) {
    if (concept === 'operatingProfit') {
      const direct = valueAt(annRows, concept, lastIdx);
      if (direct != null) return direct;
      // Fallback for BFSI / Banking: Operating Profit before Provisions (PPOP) = Total Income - Total Expenses
      const inc = valueAt(annRows, 'revenue', lastIdx) ?? valueAt(annRows, 'T_INC_CON_OPR_BFSI', lastIdx);
      const exp = valueAt(annRows, 'TOTAL_OPEX', lastIdx);
      if (inc != null && exp != null) return Math.round((inc - exp) * 100) / 100;
      return null;
    }
    if (concept === 'opm') {
      const direct = valueAt(annRows, concept, lastIdx);
      if (direct != null) return direct;
      const op = annVal('operatingProfit');
      const rev = annVal('revenue');
      if (op != null && rev != null && rev !== 0) return Math.round((op / rev) * 10000) / 100;
      return valueAt(annRows, 'NPM_PERCENT', lastIdx) ?? valueAt(annRows, 'NIM_PCT', lastIdx);
    }
    if (concept === 'nim') {
      // NIM might be reported up to prior year if latest year is preliminary
      return valueAt(annRows, concept, lastIdx) ?? latestNonNull(annRows, concept, lastIdx);
    }
    return valueAt(annRows, concept, lastIdx);
  }

  const bsAnnRows  = bs.rows    ?? [];
  const bsPeriods  = bs.periods ?? [];
  const bsLastIdx  = lastReportedIdx(bsAnnRows, bsPeriods);

  function bsVal(concept) {
    return valueAt(bsAnnRows, concept, bsLastIdx);
  }

  const cfRows     = cf.rows    ?? [];
  const cfPeriods  = cf.periods ?? [];
  const cfLastIdx  = lastReportedIdx(cfRows, cfPeriods);

  function cfVal(concept) {
    return valueAt(cfRows, concept, cfLastIdx);
  }

  const borrowings = bsVal('borrowings');
  const equity     = bsVal('equityCapital');
  const reserves   = bsVal('reserves');
  const netWorthCr = (equity != null && reserves != null) ? equity + reserves : val.bookValue;
  const de         = (borrowings != null && netWorthCr != null && netWorthCr !== 0)
    ? Math.round((borrowings / netWorthCr) * 100) / 100
    : null;

  // Compute YoY growth from annual data as fallback when CAGR is unavailable
  const revRow    = findRow(annRows, 'revenue');
  const profRow   = findRow(annRows, 'netProfit');
  const n         = annPeriods.length;

  // Anchored on lastIdx, not the raw tail, for the same unreported-period
  // reason as lastReportedIdx.
  function yoy(seriesValues) {
    if (!seriesValues || lastIdx < 1) return null;
    const prev = seriesValues[lastIdx - 1];
    const curr = seriesValues[lastIdx];
    if (!prev || !curr || prev === 0) return null;
    return Math.round(((curr - prev) / Math.abs(prev)) * 100);
  }

  const revYoY    = yoy(revRow?.values);
  const profYoY   = yoy(profRow?.values);

  // Best available growth label: CAGR if present, else YoY, else N/A
  const salesGrowthLabel = met.salesGrowth?.['3y'] != null
    ? `3Y CAGR: ${pct(met.salesGrowth['3y'])}`
    : met.salesGrowth?.['5y'] != null
      ? `5Y CAGR: ${pct(met.salesGrowth['5y'])}`
      : met.salesGrowth?.['10y'] != null
        ? `10Y CAGR: ${pct(met.salesGrowth['10y'])}`
        : revYoY != null
          ? `YoY (${annPeriods[lastIdx - 1]}→${annPeriods[lastIdx]}): ${pct(revYoY)}`
          : 'N/A';

  const profGrowthLabel = met.profitGrowth?.['3y'] != null
    ? `3Y CAGR: ${pct(met.profitGrowth['3y'])}`
    : met.profitGrowth?.['10y'] != null
      ? `10Y CAGR: ${pct(met.profitGrowth['10y'])}`
      : profYoY != null
        ? `YoY (${annPeriods[lastIdx - 1]}→${annPeriods[lastIdx]}): ${pct(profYoY)}`
        : 'N/A';

  const roeLabel = met.roe?.['3y'] != null
    ? `Avg 3Y: ${pct(met.roe['3y'])}`
    : met.roe?.['5y'] != null
      ? `Avg 5Y: ${pct(met.roe['5y'])}`
      : met.roe?.last != null
        ? `Latest: ${pct(met.roe.last)}`
        : 'N/A';

  // Sector context for the `industry` signal — financials.analyze() carries no
  // identity fields, so this comes from osc_identity.csv (cached in-process by
  // lib/peerIdentity). Missing symbols degrade to N/A, which the prompt maps to
  // "Insufficient Data" rather than letting the model guess a sector.
  const ident = peerIdentity.getIdentity(symbol) ?? {};

  const advances = annVal('advances') ?? bsVal('advances');
  const deposits = annVal('deposits') ?? bsVal('deposits');
  const nim      = annVal('nim');
  const gnpa     = annVal('grossNpa');
  const nnpa     = annVal('netNpa');
  const isBfsi   = advances != null || deposits != null || nim != null || gnpa != null;

  const bfsiBlock = isBfsi
    ? `\n=== BANKING / BFSI METRICS (Latest Reported Annual: ${annPeriods[lastIdx] ?? 'N/A'}) ===
Advances:       ${cr(advances)}
Deposits:       ${cr(deposits)}
NIM:            ${pct(nim)}
Gross NPA (%):  ${pct(gnpa)}
Net NPA (%):    ${pct(nnpa)}`
    : '';

  return `SYMBOL: ${symbol}
LATEST ANNUAL PERIOD: ${annPeriods[lastIdx] ?? 'N/A'}
ANNUAL PERIODS AVAILABLE: ${n}

=== COMPANY IDENTITY ===
Company Name:   ${na(ident.companyName)}
Industry Group: ${na(ident.industryGroup)}
Basic Industry: ${na(ident.basicIndustry)}
Main Product:   ${na(ident.mainProduct)}

=== INCOME STATEMENT (TTM / Latest Reported Annual: ${annPeriods[lastIdx] ?? 'N/A'}) ===
Revenue (TTM):        ${cr(ttm.revenue)}   | Latest Annual: ${cr(annVal('revenue'))}
EBITDA (TTM):         ${cr(ttm.ebitda)}
Operating Profit:     ${cr(annVal('operatingProfit'))}   | OPM: ${pct(annVal('opm'))}
Net Profit (TTM):     ${cr(ttm.netProfit)}  | Latest Annual: ${cr(annVal('netProfit'))}
EPS (TTM):            ${na(ttm.eps)}

=== GROWTH METRICS ===
Revenue Growth | Best available: ${salesGrowthLabel}
               Full CAGR: 3Y: ${pct(met.salesGrowth?.['3y'])}  | 5Y: ${pct(met.salesGrowth?.['5y'])}  | 10Y: ${pct(met.salesGrowth?.['10y'])}
               YoY: ${revYoY != null ? pct(revYoY) : 'N/A'}
Profit Growth  | Best available: ${profGrowthLabel}
               Full CAGR: 3Y: ${pct(met.profitGrowth?.['3y'])} | 10Y: ${pct(met.profitGrowth?.['10y'])}
               YoY: ${profYoY != null ? pct(profYoY) : 'N/A'}
Stock CAGR     | 1Y: ${pct(met.stockPriceCagr?.['1y'])} | 5Y: ${pct(met.stockPriceCagr?.['5y'])} | 10Y: ${pct(met.stockPriceCagr?.['10y'])}

=== PROFITABILITY & RETURNS ===
ROE | Best available: ${roeLabel}
    Full: Last: ${pct(met.roe?.last)}  | 3Y avg: ${pct(met.roe?.['3y'])}  | 5Y avg: ${pct(met.roe?.['5y'])}  | 10Y avg: ${pct(met.roe?.['10y'])}
Operating Margin (Latest): ${pct(annVal('opm'))}

=== VALUATION ===
Market Cap:     ${cr(val.marketCap)}
P/E Ratio:      ${na(val.peRatio)}
P/B Ratio:      ${na(val.pbRatio)}
Book Value:     ${cr(val.bookValue)}
EPS (Latest):   ${na(val.eps)}

=== BALANCE SHEET (Latest Reported Annual: ${bsPeriods[bsLastIdx] ?? 'N/A'}) ===
Equity Capital:   ${cr(equity)}
Reserves:         ${cr(reserves)}
Borrowings:       ${cr(borrowings)}
Total Assets:     ${cr(bsVal('totalAssets'))}
Fixed Assets:     ${cr(bsVal('fixedAssets'))}
Investments:      ${cr(bsVal('investments'))}
Debt-to-Equity:   ${na(de)}

=== CASH FLOW (Latest Reported Annual: ${cfPeriods[cfLastIdx] ?? 'N/A'}) ===
Cash from Operations: ${cr(cfVal('operatingCF'))}
Cash from Investing:  ${cr(cfVal('investingCF'))}
Cash from Financing:  ${cr(cfVal('financingCF'))}${bfsiBlock}`;
}

/**
 * Build the full prompt for fundamentals intelligence generation.
 * The prompt template (with {{DATA_BLOCK}} placeholder) MUST come from the DB
 * (Skill.promptTemplate). Throws if not provided.
 *
 * @param {string}      symbol
 * @param {object}      finResult   Full financials.analyze() result
 * @param {string|null} dbTemplate  Skill.promptTemplate from DB
 */
function fundamentalsIntelligencePrompt(symbol, finResult, dbTemplate) {
  if (!dbTemplate) {
    throw new Error('[fundamentalsIntelligencePrompt] promptTemplate must come from DB — Skill slug: "fundamentals-intelligence"');
  }
  const dataBlock = buildDataBlock(symbol, finResult);
  return dbTemplate.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { fundamentalsIntelligencePrompt, buildDataBlock };
