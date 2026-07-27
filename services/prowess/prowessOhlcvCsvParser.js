'use strict';

/**
 * Parses Prowess "QueryOnStockPricesAndRatios"-shaped output into rows for
 * prowessOhlcvIngester.upsertBatch(). Two source formats share one 6-row
 * header layout, just represented differently:
 *
 *   CSV  (historic bulk-dump exports, e.g. extras/ohlcv/*.csv) — comma-separated
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
 *
 * A second, "flat" response shape exists too: one row per company with a
 * literal 'Date' field/column, instead of the date living in row 5 and
 * fields repeating per date-block. Produced by queries asking for each
 * company's latest available data point (e.g. -refyear{L} -outyear{AP})
 * rather than one synchronized trading day across the whole batch — row 5
 * holds a Prowess period code ("L") there, not a real date, so the date has
 * to be read per-row from the 'Date' column instead. Each company's "latest"
 * can be a different date (today for an active stock, years stale for a
 * delisted one) — accepted as-is, not treated as an error.
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

// Prowess field labels that mean "there's PE-like data in this row/query" —
// checked wherever the plain 'P/E' label used to be the only signal. Added
// 2026-07-25 for a custom QueryOnStockPricesAndRatios expression producing
// "Consolidated PE"/"Calculated PE Ratio" instead of the plain 'P/E' column
// (see nse_equity_new.pe_consolidated/pe_standalone) — a query requesting
// ONLY one of these (no 'P/E', no 'Opening Price') used to be misclassified
// as an 'ohlcv'-type result (isValuation only checked for 'P/E'), which then
// silently dropped every row (open/high/low/close all NaN -> skipped).
const PE_LIKE_FIELDS = ['P/E', 'Consolidated PE', 'Calculated PE Ratio'];
function hasAnyPeField(fields) {
  return PE_LIKE_FIELDS.some((f) => fields.has(f));
}

// Quote-aware split, used only for osc_identity.csv (buildNameToSymbolMap
// below) — that file's free-text fields (Business Description, addresses,
// etc.) contain literal commas inside quoted values, which the naive
// splitCsvLine() above breaks on (it doesn't respect quotes at all). That
// misalignment shifts every later column by however many embedded commas
// came before it in that specific row — confirmed to silently map "Godrej
// Industries Ltd." -> "DIVERSIFIED" and "Godrej Properties Ltd." ->
// "RESIDENTIAL" (an industry-label column landing on the NSE-symbol
// position by coincidence) instead of their real tickers, corrupting
// nse_equity_new for those symbols on every batch ingest. Completely
// separate from the day-block price CSV/JSON parsing below (parseOhlcvCsv/
// parseOhlcvRows), which never contains embedded commas — untouched here.
function splitCsvLineQuoted(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

function buildNameToSymbolMap(identityCsvPath) {
  const lines = fs.readFileSync(identityCsvPath, 'utf8')
    .replace(/^﻿/, '')
    .split('\n')
    .filter(Boolean);

  const header  = splitCsvLineQuoted(lines[0]);
  const nameIdx = header.indexOf('Company Name');
  const symIdx  = header.indexOf('NSE symbol');
  if (nameIdx === -1 || symIdx === -1) throw new Error('osc_identity.csv missing expected columns');

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLineQuoted(lines[i]);
    const name = cols[nameIdx];
    const sym  = cols[symIdx];
    if (name && sym) map[name] = sym.toUpperCase();
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
  const isValuation = !fields.has('Opening Price') && hasAnyPeField(fields);

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
    // Deliberately NOT 'Number of Transactions' -- a trade *count*, not shares
    // traded, and some queries request both fields; mapping only one avoids
    // whichever column lands later in a day's block silently overwriting the
    // other in `vol` (this table's `volume` has always meant shares traded).
    else if (field === 'Shares traded')          dayMap[dateStr].vol       = col;
    else if (field === 'Traded Quantity')        dayMap[dateStr].vol       = col;
    else if (field === 'P/E')                    dayMap[dateStr].pe        = col;
    else if (field === 'Consolidated PE')        dayMap[dateStr].peConsolidated = col;
    else if (field === 'Calculated PE Ratio')    dayMap[dateStr].peStandalone   = col;
    else if (field === 'Market Capitalisation')  dayMap[dateStr].marketCap = col;
    else if (field === 'Enterprise value')       dayMap[dateStr].marketCap = col;
  }

  const validDays = isValuation
    ? Object.entries(dayMap).filter(([, idx]) => idx.pe != null || idx.marketCap != null || idx.peConsolidated != null || idx.peStandalone != null)
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

      const pe             = idx.pe             != null ? parseFloat(cols[idx.pe])             : null;
      const marketCap       = idx.marketCap       != null ? parseFloat(cols[idx.marketCap])       : null;
      const eps             = idx.eps             != null ? parseFloat(cols[idx.eps])             : null;
      const peConsolidated  = idx.peConsolidated  != null ? parseFloat(cols[idx.peConsolidated])  : null;
      const peStandalone    = idx.peStandalone    != null ? parseFloat(cols[idx.peStandalone])    : null;

      if (isValuation) {
        if ((pe == null || isNaN(pe)) && (marketCap == null || isNaN(marketCap))
          && (peConsolidated == null || isNaN(peConsolidated)) && (peStandalone == null || isNaN(peStandalone))) continue;
        records.push({
          symbol, company_name: companyName, datetime: dt,
          pe:              !isNaN(pe)             ? pe             : null,
          market_cap_cr:   !isNaN(marketCap)      ? marketCap      : null,
          pe_consolidated: !isNaN(peConsolidated) ? peConsolidated : null,
          pe_standalone:   !isNaN(peStandalone)   ? peStandalone   : null,
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
          volume:          vol != null && !isNaN(vol) ? vol : null,
          pe:              !isNaN(pe)             ? pe             : null,
          eps:             !isNaN(eps)            ? eps            : null,
          market_cap_cr:   !isNaN(marketCap)      ? marketCap      : null,
          pe_consolidated: !isNaN(peConsolidated) ? peConsolidated : null,
          pe_standalone:   !isNaN(peStandalone)   ? peStandalone   : null,
        });
      }
    }
  }

  return { type: isValuation ? 'valuation' : 'ohlcv', records, skippedName };
}

/**
 * Parses the flat shape's numeric 'DD-MM-YYYY' date column (e.g. "23-07-2026").
 * Deliberately NOT the shared parseDate() above — that one hands its string
 * straight to `new Date()`, which is fine for the day-block shape's
 * unambiguous "01 Feb 2022" dates but silently misreads "DD-MM-YYYY" as
 * MM-DD-YYYY (confirmed: "10-03-2023" parses as 3 Oct 2023, not 10 Mar 2023),
 * and returns null outright whenever DD > 12. A dedicated, explicit parser
 * avoids both failure modes without touching parseDate/parseOhlcvRows.
 */
function parseFlatDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * "Flat" batch-API JSON shape (see file docblock) — one row per company,
 * date read from its own 'Date' column instead of a shared header row.
 *
 * Deliberately fully self-contained — shares no code with parseOhlcvRows,
 * so the day-block shape (every historic docs/ohlcv/*.csv file, every CSV an
 * admin has ever uploaded, and the original batch-API shape) is untouched by
 * this and provably unaffected by changes here.
 *
 * @returns {{ type: 'ohlcv'|'valuation'|'unknown', records: Array, skippedName: number }}
 */
function parseOhlcvFlatRows(head, data, nameToSymbol) {
  const fieldRow = head[5];

  const idx = {};
  for (let col = 0; col < fieldRow.length; col++) {
    const field = fieldRow[col];
    if      (field === 'Date')                   idx.date      = col;
    else if (field === 'Opening Price')          idx.open      = col;
    else if (field === 'High Price')             idx.high      = col;
    else if (field === 'Low Price')              idx.low       = col;
    else if (field === 'Closing Price')          idx.close     = col;
    else if (field === 'EPS')                    idx.eps       = col;
    else if (field === 'Shares traded')          idx.vol       = col;
    else if (field === 'Traded Quantity')        idx.vol       = col;
    else if (field === 'P/E')                    idx.pe        = col;
    else if (field === 'Consolidated PE')        idx.peConsolidated = col;
    else if (field === 'Calculated PE Ratio')    idx.peStandalone   = col;
    else if (field === 'Market Capitalisation')  idx.marketCap = col;
    else if (field === 'Enterprise value')       idx.marketCap = col;
  }

  const fields = new Set(fieldRow);
  const isValuation = !fields.has('Opening Price') && hasAnyPeField(fields);

  const records = [];
  let skippedName = 0;
  if (idx.date == null) return { type: isValuation ? 'valuation' : 'ohlcv', records, skippedName };

  for (const cols of data) {
    const companyName = cols[1]; // JSON batch shape: 0 = company code, 1 = company name
    if (!companyName) continue;

    const symbol = nameToSymbol[companyName];
    if (!symbol) { skippedName++; continue; }

    const dt = parseFlatDate(cols[idx.date]);
    if (!dt) continue;

    const pe             = idx.pe             != null ? parseFloat(cols[idx.pe])             : null;
    const marketCap       = idx.marketCap       != null ? parseFloat(cols[idx.marketCap])       : null;
    const eps             = idx.eps             != null ? parseFloat(cols[idx.eps])             : null;
    const peConsolidated  = idx.peConsolidated  != null ? parseFloat(cols[idx.peConsolidated])  : null;
    const peStandalone    = idx.peStandalone    != null ? parseFloat(cols[idx.peStandalone])    : null;

    if (isValuation) {
      if ((pe == null || isNaN(pe)) && (marketCap == null || isNaN(marketCap))
        && (peConsolidated == null || isNaN(peConsolidated)) && (peStandalone == null || isNaN(peStandalone))) continue;
      records.push({
        symbol, company_name: companyName, datetime: dt,
        pe:              !isNaN(pe)             ? pe             : null,
        market_cap_cr:   !isNaN(marketCap)      ? marketCap      : null,
        pe_consolidated: !isNaN(peConsolidated) ? peConsolidated : null,
        pe_standalone:   !isNaN(peStandalone)   ? peStandalone   : null,
      });
    } else {
      const open  = idx.open  != null ? parseFloat(cols[idx.open])  : NaN;
      const high  = idx.high  != null ? parseFloat(cols[idx.high])  : NaN;
      const low   = idx.low   != null ? parseFloat(cols[idx.low])   : NaN;
      const close = idx.close != null ? parseFloat(cols[idx.close]) : NaN;
      const vol   = idx.vol != null ? parseInt(cols[idx.vol], 10) : null;
      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
      records.push({
        symbol, company_name: companyName, datetime: dt, open, high, low, close,
        volume:          vol != null && !isNaN(vol) ? vol : null,
        pe:              !isNaN(pe)             ? pe             : null,
        eps:             !isNaN(eps)            ? eps            : null,
        market_cap_cr:   !isNaN(marketCap)      ? marketCap      : null,
        pe_consolidated: !isNaN(peConsolidated) ? peConsolidated : null,
        pe_standalone:   !isNaN(peStandalone)   ? peStandalone   : null,
      });
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
  if (!Array.isArray(head) || !Array.isArray(data) || head.length < 6) {
    return { type: 'unknown', records: [], skippedName: 0 };
  }
  // 'Date' as a recognized field name only ever appears in the "flat" shape
  // (see parseOhlcvFlatRows) — the day-block shape's dates live only in
  // head[4], never as a field name in head[5]. CSV never produces this shape.
  if (head[5].includes('Date')) {
    return parseOhlcvFlatRows(head, data, nameToSymbol);
  }
  return parseOhlcvRows(head, data, nameToSymbol, 1);
}

module.exports = { parseOhlcvCsv, parseOhlcvJson, buildNameToSymbolMap };
