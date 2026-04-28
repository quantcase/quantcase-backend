'use strict';

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

  const annPeriods = ann.periods ?? [];
  const annRows    = ann.rows    ?? [];
  const lastIdx    = annPeriods.length - 1;

  function annVal(key) {
    const row = annRows.find((r) => r.key === key);
    if (!row || lastIdx < 0) return null;
    return row.values[lastIdx] ?? null;
  }

  const bsAnnRows  = bs.rows    ?? [];
  const bsLastIdx  = (bs.periods ?? []).length - 1;

  function bsVal(key) {
    const row = bsAnnRows.find((r) => r.key === key);
    if (!row || bsLastIdx < 0) return null;
    return row.values[bsLastIdx] ?? null;
  }

  const cfRows    = cf.rows    ?? [];
  const cfLastIdx = (cf.periods ?? []).length - 1;

  function cfVal(key) {
    const row = cfRows.find((r) => r.key === key);
    if (!row || cfLastIdx < 0) return null;
    return row.values[cfLastIdx] ?? null;
  }

  const borrowings = bsVal('borrowings');
  const equity     = bsVal('equityCapital');
  const reserves   = bsVal('reserves');
  const netWorthCr = (equity != null && reserves != null) ? equity + reserves : val.bookValue;
  const de         = (borrowings != null && netWorthCr != null && netWorthCr !== 0)
    ? Math.round((borrowings / netWorthCr) * 100) / 100
    : null;

  // Compute YoY growth from annual data as fallback when CAGR is unavailable
  const revRow    = annRows.find((r) => r.key === 'revenue');
  const profRow   = annRows.find((r) => r.key === 'netProfit');
  const n         = annPeriods.length;

  function yoy(seriesValues) {
    if (!seriesValues || seriesValues.length < 2) return null;
    const prev = seriesValues[seriesValues.length - 2];
    const curr = seriesValues[seriesValues.length - 1];
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
          ? `YoY (${annPeriods[n - 2]}→${annPeriods[n - 1]}): ${pct(revYoY)}`
          : 'N/A';

  const profGrowthLabel = met.profitGrowth?.['3y'] != null
    ? `3Y CAGR: ${pct(met.profitGrowth['3y'])}`
    : met.profitGrowth?.['10y'] != null
      ? `10Y CAGR: ${pct(met.profitGrowth['10y'])}`
      : profYoY != null
        ? `YoY (${annPeriods[n - 2]}→${annPeriods[n - 1]}): ${pct(profYoY)}`
        : 'N/A';

  const roeLabel = met.roe?.['3y'] != null
    ? `Avg 3Y: ${pct(met.roe['3y'])}`
    : met.roe?.['5y'] != null
      ? `Avg 5Y: ${pct(met.roe['5y'])}`
      : met.roe?.last != null
        ? `Latest: ${pct(met.roe.last)}`
        : 'N/A';

  return `SYMBOL: ${symbol}
LATEST ANNUAL PERIOD: ${annPeriods[lastIdx] ?? 'N/A'}
ANNUAL PERIODS AVAILABLE: ${n}

=== INCOME STATEMENT (TTM / Latest Annual) ===
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

=== BALANCE SHEET (Latest Annual) ===
Equity Capital:   ${cr(equity)}
Reserves:         ${cr(reserves)}
Borrowings:       ${cr(borrowings)}
Total Assets:     ${cr(bsVal('totalAssets'))}
Fixed Assets:     ${cr(bsVal('fixedAssets'))}
Investments:      ${cr(bsVal('investments'))}
Debt-to-Equity:   ${na(de)}

=== CASH FLOW (Latest Annual) ===
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
