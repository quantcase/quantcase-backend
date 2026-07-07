'use strict';

/**
 * Shared CSV serialization for the L1/L2 "signal availability" reports —
 * one row per ticker, with a count + list of {fiscal_year, quarter?, count}
 * periods per named group (e.g. transcript, transcript_signal, ppt,
 * annual_report). CSV has no native nested/grouped-header concept, so
 * columns are flattened to "<group>_<period>" (e.g. transcript_FY2026_Q4,
 * annual_report_FY2025) — only periods actually present in the given ticker
 * set get a column, most-recent-first, no fixed/padded set of periods.
 *
 * Expected input shape (per ticker):
 *   { ticker, <group.key>: {total, periods}, ... one per entry in `groups` }
 *   quarterly periods: { fiscal_year, quarter, count }
 *   yearly periods:    { fiscal_year, count }
 */

// Comparable rank for (fiscal_year, quarter) — higher = more recent. `quarter`
// may be null for yearly periods.
function periodRank(fiscal_year, quarter) {
  const y = parseInt(String(fiscal_year ?? '').match(/(\d{4})/)?.[1] ?? '', 10);
  if (Number.isNaN(y)) return -Infinity;
  const q = parseInt(String(quarter ?? '').match(/(\d)/)?.[1] ?? '0', 10) || 0;
  return y * 10 + q;
}

function escape(v) {
  return v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
}

// Default 3-group shape used by L2's signal-count report.
const DEFAULT_GROUPS = [
  { key: 'transcript',    kind: 'quarterly' },
  { key: 'ppt',           kind: 'quarterly' },
  { key: 'annual_report', kind: 'yearly' },
];

function periodKey(kind, p) {
  return kind === 'yearly' ? p.fiscal_year : `${p.fiscal_year}_${p.quarter}`;
}

function sortCols(kind, cols) {
  return kind === 'yearly'
    ? [...cols].sort((a, b) => periodRank(b, null) - periodRank(a, null))
    : [...cols].sort((a, b) => {
        const [fyA, qA] = a.split('_'); const [fyB, qB] = b.split('_');
        return periodRank(fyB, qB) - periodRank(fyA, qA);
      });
}

// Column set (per group) is inherently derived from the full data set — a
// period only gets a column if some ticker in the set actually has it, so
// there's no way to know the header without having seen every row. This is
// the one part streaming can't avoid touching all the data for; what
// streaming *does* avoid is holding both the row-string array and the final
// joined mega-string in memory at once (see writeSignalReportCsv below).
function computeColumns(perTicker, groups) {
  const colsByGroup = new Map(groups.map(g => [g.key, new Set()]));
  for (const row of perTicker) {
    for (const g of groups) {
      const periods = row[g.key]?.periods ?? [];
      for (const p of periods) colsByGroup.get(g.key).add(periodKey(g.kind, p));
    }
  }
  return new Map(groups.map(g => [g.key, sortCols(g.kind, colsByGroup.get(g.key))]));
}

function buildHeader(groups, sortedColsByGroup) {
  const header = ['companyName'];
  for (const g of groups) {
    header.push(`${g.key}_total`, ...sortedColsByGroup.get(g.key).map(c => `${g.key}_${c}`));
  }
  return header.join(',');
}

function buildRow(row, groups, sortedColsByGroup) {
  const line = [row.ticker];
  for (const g of groups) {
    const data = row[g.key] ?? { total: 0, periods: [] };
    const byKey = new Map(data.periods.map(p => [periodKey(g.kind, p), p.count]));
    line.push(data.total ?? 0, ...sortedColsByGroup.get(g.key).map(c => byKey.get(c) ?? 0));
  }
  return line.map(escape).join(',');
}

function buildSignalReportCsv(perTicker, groups = DEFAULT_GROUPS) {
  const sortedColsByGroup = computeColumns(perTicker, groups);
  const lines = [buildHeader(groups, sortedColsByGroup)];
  for (const row of perTicker) lines.push(buildRow(row, groups, sortedColsByGroup));
  return lines.join('\n');
}

// Same output as buildSignalReportCsv, written directly to an Express
// response via res.write() one row at a time instead of building an array of
// every line then joining it into one string. For an `all`-scale report
// (thousands of tickers) this avoids holding the formatted-lines array and
// the final joined string in memory simultaneously, and starts sending bytes
// to the client as soon as the header is known instead of only after the
// entire CSV has been assembled — meaningfully shortens time-to-first-byte
// on a slow/large report and avoids one big synchronous res.send() call.
function writeSignalReportCsv(res, perTicker, groups = DEFAULT_GROUPS) {
  const sortedColsByGroup = computeColumns(perTicker, groups);
  res.write(buildHeader(groups, sortedColsByGroup) + '\n');
  for (const row of perTicker) res.write(buildRow(row, groups, sortedColsByGroup) + '\n');
  res.end();
}

module.exports = { periodRank, buildSignalReportCsv, writeSignalReportCsv, DEFAULT_GROUPS };
