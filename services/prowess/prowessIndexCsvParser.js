'use strict';

/**
 * Parses a Prowess index-export (e.g. "QueryOnIndex..." output) into rows
 * shaped for nse_equity_new — nse_index is deprecated, indices go in the same
 * table as stocks now, keyed the same way (symbol+datetime PK; here `symbol`
 * is the index name itself, e.g. "Bse 100", since indices have no NSE ticker).
 *
 * Every data row carries its own explicit "Index Date" column — used
 * directly instead of reconstructing the date from a header row, since it's
 * authoritative per-row (unlike the stock OHLCV day-block export).
 *
 * Two export templates seen from Prowess so far, both handled here:
 *   - comma-delimited, quoted fields, exactly 6 metadata rows before the
 *     field-name row (verified against osc_sheet_136.csv, 742 index rows).
 *   - pipe-delimited, unquoted, with a stray "Output source file name: ..."
 *     line plus only 3 metadata rows before the field-name row (verified
 *     against a "T1"-query bulk export, 124 indices x ~1yr of daily rows).
 * Row *count* before the data isn't hardcoded for this reason — the
 * delimiter is auto-detected, and the field-name row (and hence where data
 * starts) is located by scanning for the row containing "Index Name" /
 * "Index Date", not by a fixed offset.
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

// Sniffed from the first few lines rather than assumed, since Prowess export
// templates for the same query type differ: comma+quotes (osc_sheet_136.csv)
// vs. pipe+unquoted ("T1"-query bulk export). Whichever separator appears
// more often across the sample wins.
function detectDelimiter(lines) {
  const sample = lines.slice(0, 10).join('\n');
  const pipeCount = (sample.match(/\|/g) || []).length;
  const commaCount = (sample.match(/,/g) || []).length;
  return pipeCount > commaCount ? '|' : ',';
}

function splitLine(line, delimiter) {
  return line.split(delimiter).map(stripQuotes);
}

// Located by content, not a fixed row offset — export templates differ in
// how many metadata rows precede it (6 for the comma template, 3 plus a
// stray "Output source file name: ..." line for the pipe template).
function findFieldRowIndex(lines, delimiter) {
  for (let i = 0; i < lines.length; i++) {
    const cols = splitLine(lines[i], delimiter);
    if (cols.includes('Index Name') && cols.includes('Index Date')) return i;
  }
  return -1;
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
  if (lines.length < 2) return { records: [], skippedRows: 0 };

  const delimiter = detectDelimiter(lines);
  const fieldRowIdx = findFieldRowIndex(lines, delimiter);
  if (fieldRowIdx === -1) throw new Error('Index CSV missing expected column "Index Name"');

  const fieldRow = splitLine(lines[fieldRowIdx], delimiter);
  const colIdx = {};
  fieldRow.forEach((name, i) => { colIdx[name] = i; });

  const required = ['Index Name', 'Index Date', 'Index Opening', 'Index High', 'Index Low', 'Index Closing'];
  for (const col of required) {
    if (colIdx[col] === undefined) throw new Error(`Index CSV missing expected column "${col}"`);
  }

  const records = [];
  let skippedRows = 0;

  for (let r = fieldRowIdx + 1; r < lines.length; r++) {
    const cols = splitLine(lines[r], delimiter);
    const indexName = cols[colIdx['Index Name']];
    const datetime = parseIndexDate(cols[colIdx['Index Date']]);
    if (!indexName || !datetime) { skippedRows++; continue; }

    const open  = parseFloat(cols[colIdx['Index Opening']]);
    const high  = parseFloat(cols[colIdx['Index High']]);
    const low   = parseFloat(cols[colIdx['Index Low']]);
    const close = parseFloat(cols[colIdx['Index Closing']]);
    if (isNaN(open) && isNaN(high) && isNaN(low) && isNaN(close)) { skippedRows++; continue; }

    const pe        = colIdx['Index PE']              !== undefined ? parseFloat(cols[colIdx['Index PE']])              : NaN;
    const marketCap = colIdx['Index Marketcap']        !== undefined ? parseFloat(cols[colIdx['Index Marketcap']])        : NaN;
    const pctChange = colIdx['Daily Index Returns']    !== undefined ? parseFloat(cols[colIdx['Daily Index Returns']])    : NaN;

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
      pct_change:    !isNaN(pctChange) ? pctChange : null,
    });
  }

  return { records, skippedRows };
}

/** 
 * Parsed JSON batch result ({ meta, head, data }, format=json) 
 * Returns the same shape as parseIndexCsv.
 */
function parseIndexJson(jsonResult) {
  const { head, data } = jsonResult;
  if (!Array.isArray(head) || !Array.isArray(data) || head.length < 6) {
    return { records: [], skippedRows: 0 };
  }

  const fieldRow = head[5];
  const colIdx = {};
  fieldRow.forEach((name, i) => { colIdx[name] = i; });

  const required = ['Index Name', 'Index Date', 'Index Opening', 'Index High', 'Index Low', 'Index Closing'];
  for (const col of required) {
    if (colIdx[col] === undefined) throw new Error(`Index JSON missing expected column "${col}"`);
  }

  const records = [];
  let skippedRows = 0;

  for (const cols of data) {
    const indexName = cols[colIdx['Index Name']];
    const datetime = parseIndexDate(cols[colIdx['Index Date']]);
    if (!indexName || !datetime) { skippedRows++; continue; }

    const open  = parseFloat(cols[colIdx['Index Opening']]);
    const high  = parseFloat(cols[colIdx['Index High']]);
    const low   = parseFloat(cols[colIdx['Index Low']]);
    const close = parseFloat(cols[colIdx['Index Closing']]);
    if (isNaN(open) && isNaN(high) && isNaN(low) && isNaN(close)) { skippedRows++; continue; }

    const pe        = colIdx['Index PE']              !== undefined ? parseFloat(cols[colIdx['Index PE']])              : NaN;
    const marketCap = colIdx['Index Marketcap']       !== undefined ? parseFloat(cols[colIdx['Index Marketcap']])       : NaN;
    const pctChange = colIdx['Daily Index Returns']   !== undefined ? parseFloat(cols[colIdx['Daily Index Returns']])   : NaN;

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
      pct_change:    !isNaN(pctChange) ? pctChange : null,
    });
  }

  return { records, skippedRows };
}

module.exports = { parseIndexCsv, parseIndexJson };
