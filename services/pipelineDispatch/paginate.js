'use strict';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Slices a resolved ticker list into one page, clamping page/pageSize to sane
// bounds. Used by the L1/L2 JSON preview endpoints so a request against a
// huge groupSlug/`all` (~2,000 companies) can't pull every ticker's calls/
// reports/signals into one response — the DB queries downstream are scoped
// to just this page's tickers, not the whole resolved set, so this bounds
// both query size and response payload size. CSV exports intentionally don't
// use this — those are meant to be a full dump.
function paginateTickers(tickers, { page, pageSize } = {}) {
  const size = Math.min(Math.max(parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(tickers.length / size));
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), totalPages);
  const start = (p - 1) * size;
  return { pageTickers: tickers.slice(start, start + size), page: p, pageSize: size, totalPages };
}

// Splits a ticker list into fixed-size batches — used by the CSV report
// builders to issue several smaller DB queries instead of one query scoped
// to the entire (possibly ~2,000-ticker) resolved set, so a single query
// can't run long enough to hit Postgres's statement_timeout.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { paginateTickers, chunk, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
