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
  const s   = finResult?.standardized ?? {};
  const ttm = s.ttm       ?? {};
  const met = s.metrics   ?? {};
  const val = s.valuation ?? {};
  const bs  = s.balanceSheet?.annual ?? {};
  const cf  = s.cashFlow  ?? {};
  const ann = s.annual    ?? {};

  // financials.analyze() labels statement rows with KPI codes (REV_OP, CFO,
  // BORR_TOTAL, …), not camelCase names. Lookups take a candidate list because
  // the annual P&L row set varies by screen config — a plain P&L company
  // returns REV_OP/OP_PROFIT/PAT while others return GROSS_PROFIT/
  // FINANCING_PROFIT — and a missing concept must degrade to N/A, not to a
  // wrong row.
  const ROW_KEYS = {
    revenue:         ['REV_OP'],
    operatingProfit: ['OP_PROFIT', 'GROSS_PROFIT'],
    opm:             ['OPM'],
    netProfit:       ['PAT'],
    equityCapital:   ['EQ_SHARE_CAP'],
    reserves:        ['RES_SURPLUS'],
    borrowings:      ['BORR_TOTAL'],
    totalAssets:     ['TOTAL_ASSETS'],
    fixedAssets:     ['ASSET_PPE'],
    investments:     ['INV_NONCURR'],
    operatingCF:     ['CFO'],
    investingCF:     ['CFI'],
    financingCF:     ['CFF'],
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

  const annPeriods = ann.periods ?? [];
  const annRows    = ann.rows    ?? [];
  const lastIdx    = lastReportedIdx(annRows, annPeriods);

  function annVal(concept) {
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
Cash from Financing:  ${cr(cfVal('financingCF'))}`;
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
