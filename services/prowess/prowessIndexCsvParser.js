'use strict';

/**
 * Parses a Prowess index-export CSV (e.g. "QueryOnIndex..." output) into rows
 * shaped for nse_equity_new — nse_index is deprecated, indices go in the same
 * table as stocks now, keyed the same way (symbol+datetime PK; here `symbol`
 * is the index name itself, e.g. "Bse 100", since indices have no NSE ticker).
 *
 * Same 6-row Prowess header convention as the stock OHLCV export, but
 * distinct in two ways verified against a real sample (osc_sheet_136.csv,
 * 742 index rows, BSE/NSE indices mixed):
 *   - column 0 is "Index Name", not a company.
 *   - each data row carries its own explicit "Index Date" column (col 1) —
 *     used directly instead of reconstructing the date from the header row,
 *     since it's authoritative and the header date-row is only one value
 *     (single-day snapshot query, same as the stock OHLCV live-batch query).
 *
 * The source data also includes PB, yield, beta, alpha, and constituent
 * count, which nse_equity_new has no columns for and which are dropped.
 * PE and Index Marketcap (Rs. Crore) do map onto nse_equity_new's existing
 * pe/market_cap_cr columns. Index Trading Volume is also Rs. Crore, not a
 * share count like nse_equity_new.volume represents for stocks — mapping it
 * in would silently mix units, so it's left null rather than guessed.
 */

function stripQuotes(s) {
  return (s || '').replace(/^"|"$/g, '').trim();
}

function splitCsvLine(line) {
  return line.split(',').map(stripQuotes);
}

/** "13-07-2026" → Date (Prowess index date format is DD-MM-YYYY, distinct from the stock CSV's "13 Jul 2026" style) */
function parseIndexDate(s) {
  const m = (s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** @returns {{ records: Array, skippedRows: number }} */
function parseIndexCsv(csvText) {
  const raw = csvText.replace(/^﻿/, '');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 7) return { records: [], skippedRows: 0 };

  const fieldRow = splitCsvLine(lines[5]);
  const colIdx = {};
  fieldRow.forEach((name, i) => { colIdx[name] = i; });

  const required = ['Index Name', 'Index Date', 'Index Opening', 'Index High', 'Index Low', 'Index Closing'];
  for (const col of required) {
    if (colIdx[col] === undefined) throw new Error(`Index CSV missing expected column "${col}"`);
  }

  const records = [];
  let skippedRows = 0;

  for (let r = 6; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    const indexName = cols[colIdx['Index Name']];
    const datetime = parseIndexDate(cols[colIdx['Index Date']]);
    if (!indexName || !datetime) { skippedRows++; continue; }

    const open  = parseFloat(cols[colIdx['Index Opening']]);
    const high  = parseFloat(cols[colIdx['Index High']]);
    const low   = parseFloat(cols[colIdx['Index Low']]);
    const close = parseFloat(cols[colIdx['Index Closing']]);
    if (isNaN(open) && isNaN(high) && isNaN(low) && isNaN(close)) { skippedRows++; continue; }

    const pe        = colIdx['Index PE']        !== undefined ? parseFloat(cols[colIdx['Index PE']])        : NaN;
    const marketCap = colIdx['Index Marketcap']  !== undefined ? parseFloat(cols[colIdx['Index Marketcap']]) : NaN;

    records.push({
      symbol: indexName, company_name: indexName, datetime,
      open:  !isNaN(open)  ? open  : null,
      high:  !isNaN(high)  ? high  : null,
      low:   !isNaN(low)   ? low   : null,
      close: !isNaN(close) ? close : null,
      volume: null,
      eps: null,
      pe:            !isNaN(pe)        ? pe        : null,
      market_cap_cr: !isNaN(marketCap) ? marketCap : null,
    });
  }

  return { records, skippedRows };
}

module.exports = { parseIndexCsv };
