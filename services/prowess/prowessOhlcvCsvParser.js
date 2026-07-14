'use strict';

/**
 * Parses Prowess "QueryOnStockPricesAndRatios"-shaped output into rows for
 * prowessOhlcvIngester.upsertBatch(). Two source formats share one 6-row
 * header layout, just represented differently:
 *
 *   CSV  (historic bulk-dump exports, e.g. docs/ohlcv/*.csv) — comma-separated
 *        text lines, company name in column 0.
 *   JSON (live Batch API, format=json — confirmed against a real response) —
 *        { meta, head: string[6][], data: string[][] }, company code in
 *        column 0 and company name in column 1.
 *
 * Header rows (both formats):
 *   Row 1: source ("CMIE Expr")   Row 2: exchange ("NSE")
 *   Row 3: type                   Row 4: units
 *   Row 5: dates — repeated once per field in that day's block
 *   Row 6: field names
 */

const fs = require('fs');

function stripQuotes(s) {
  return (s || '').replace(/^"|"$/g, '').trim();
}

function splitCsvLine(line) {
  return line.split(',').map(stripQuotes);
}

function parseDate(s) {
  const d = new Date(`${s} UTC`);
  return isNaN(d.getTime()) ? null : d;
}

const NSE_TICKER_RE = /^[A-Z0-9&-]{2,15}$/;

function extractNseSymbol(cols, symIdx) {
  for (let offset = 0; offset <= 4; offset++) {
    const val = (cols[symIdx + offset] || '').trim().toUpperCase();
    if (NSE_TICKER_RE.test(val)) return val;
  }
  return null;
}

function buildNameToSymbolMap(identityCsvPath) {
  const lines = fs.readFileSync(identityCsvPath, 'utf8')
    .replace(/^﻿/, '')
    .split('\n')
    .filter(Boolean);

  const header  = splitCsvLine(lines[0]);
  const nameIdx = header.indexOf('Company Name');
  const symIdx  = header.indexOf('NSE symbol');
  if (nameIdx === -1 || symIdx === -1) throw new Error('osc_identity.csv missing expected columns');

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const name = cols[nameIdx];
    const sym  = extractNseSymbol(cols, symIdx);
    if (name && sym) map[name] = sym;
  }
  return map;
}

/**
 * Shared core — headerRows/dataRows are already arrays-of-arrays (both CSV
 * lines and JSON `data` rows normalize to this before calling in).
 * @returns {{ type: 'ohlcv'|'valuation'|'unknown', records: Array, skippedName: number }}
 */
function parseOhlcvRows(headerRows, dataRows, nameToSymbol, nameColIdx) {
  if (headerRows.length < 6) return { type: 'unknown', records: [], skippedName: 0 };

  const dateRow  = headerRows[4];
  const fieldRow = headerRows[5];

  const fields = new Set(fieldRow);
  const isValuation = !fields.has('Opening Price') && fields.has('P/E');

  const dayMap = {};
  for (let col = 1; col < fieldRow.length; col++) {
    const dateStr = dateRow[col];
    const field   = fieldRow[col];
    if (!dateStr || !field) continue;
    if (!dayMap[dateStr]) dayMap[dateStr] = {};
    if      (field === 'Opening Price')          dayMap[dateStr].open      = col;
    else if (field === 'High Price')             dayMap[dateStr].high      = col;
    else if (field === 'Low Price')              dayMap[dateStr].low       = col;
    else if (field === 'Closing Price')          dayMap[dateStr].close     = col;
    else if (field === 'EPS')                    dayMap[dateStr].eps       = col;
    else if (field === 'Number of Transactions') dayMap[dateStr].vol       = col;
    else if (field === 'Shares traded')          dayMap[dateStr].vol       = col;
    else if (field === 'P/E')                    dayMap[dateStr].pe        = col;
    else if (field === 'Market Capitalisation')  dayMap[dateStr].marketCap = col;
    else if (field === 'Enterprise value')       dayMap[dateStr].marketCap = col;
  }

  const validDays = isValuation
    ? Object.entries(dayMap).filter(([, idx]) => idx.pe != null || idx.marketCap != null)
    : Object.entries(dayMap).filter(([, idx]) => idx.open != null && idx.high != null && idx.low != null && idx.close != null);

  const records = [];
  let skippedName = 0;

  for (const cols of dataRows) {
    const companyName = cols[nameColIdx];
    if (!companyName) continue;

    const symbol = nameToSymbol[companyName];
    if (!symbol) { skippedName++; continue; }

    for (const [dateStr, idx] of validDays) {
      const dt = parseDate(dateStr);
      if (!dt) continue;

      const pe        = idx.pe        != null ? parseFloat(cols[idx.pe])        : null;
      const marketCap = idx.marketCap != null ? parseFloat(cols[idx.marketCap]) : null;
      const eps       = idx.eps       != null ? parseFloat(cols[idx.eps])       : null;

      if (isValuation) {
        if ((pe == null || isNaN(pe)) && (marketCap == null || isNaN(marketCap))) continue;
        records.push({
          symbol, company_name: companyName, datetime: dt,
          pe:            !isNaN(pe)        ? pe        : null,
          market_cap_cr: !isNaN(marketCap) ? marketCap : null,
        });
      } else {
        const open  = parseFloat(cols[idx.open]);
        const high  = parseFloat(cols[idx.high]);
        const low   = parseFloat(cols[idx.low]);
        const close = parseFloat(cols[idx.close]);
        const vol   = idx.vol != null ? parseInt(cols[idx.vol], 10) : null;
        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
        records.push({
          symbol, company_name: companyName, datetime: dt, open, high, low, close,
          volume:        vol != null && !isNaN(vol) ? vol : null,
          pe:            !isNaN(pe)        ? pe        : null,
          eps:           !isNaN(eps)       ? eps       : null,
          market_cap_cr: !isNaN(marketCap) ? marketCap : null,
        });
      }
    }
  }

  return { type: isValuation ? 'valuation' : 'ohlcv', records, skippedName };
}

/** CSV text (historic bulk dumps) — company name in column 0. */
function parseOhlcvCsv(csvText, nameToSymbol) {
  const raw = csvText.replace(/^﻿/, '');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 7) return { type: 'unknown', records: [], skippedName: 0 };

  const headerRows = lines.slice(0, 6).map(splitCsvLine);
  const dataRows = lines.slice(6).map(splitCsvLine);
  return parseOhlcvRows(headerRows, dataRows, nameToSymbol, 0);
}

/** Parsed JSON batch result ({ meta, head, data }, format=json) — company name in column 1 (0 is company code). */
function parseOhlcvJson(jsonResult, nameToSymbol) {
  const { head, data } = jsonResult;
  if (!Array.isArray(head) || !Array.isArray(data)) return { type: 'unknown', records: [], skippedName: 0 };
  return parseOhlcvRows(head, data, nameToSymbol, 1);
}

module.exports = { parseOhlcvCsv, parseOhlcvJson, buildNameToSymbolMap };
