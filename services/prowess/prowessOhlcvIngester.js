'use strict';

/**
 * Prowess OHLCV upsert layer.
 * Inserts/updates rows in nse_equity_new.
 *
 * Extracted from scripts/ingest_prowess_ohlcv.js — same upsert semantics:
 *   OHLCV rows: INSERT ... ON CONFLICT DO NOTHING (price data is authoritative)
 *   Valuation rows (PE/market_cap only): ON CONFLICT DO UPDATE SET pe, market_cap_cr
 */

const prisma = require('../../config/prisma');

const BATCH_SIZE = 500;

async function upsertOhlcvBatch(rows) {
  if (!rows.length) return;

  const values = rows.map((_, i) => {
    const b = i * 11;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
  }).join(',');

  const params = rows.flatMap(r => [
    r.symbol, r.company_name ?? r.symbol, r.datetime, r.open, r.high, r.low, r.close,
    r.volume ?? null, r.pe ?? null, r.eps ?? null, r.market_cap_cr ?? null,
  ]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity_new (symbol, company_name, datetime, open, high, low, close, volume, pe, eps, market_cap_cr)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO NOTHING
  `, ...params);
}

async function upsertValuationBatch(rows) {
  if (!rows.length) return;

  // Deduplicate within batch — same (symbol, datetime) can appear multiple times
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.symbol}|${r.datetime.getTime()}`;
    const ex = seen.get(key);
    if (!ex) { seen.set(key, { ...r }); continue; }
    if (r.pe            != null) ex.pe            = r.pe;
    if (r.market_cap_cr != null) ex.market_cap_cr = r.market_cap_cr;
  }
  const deduped = Array.from(seen.values());

  const values = deduped.map((_, i) => {
    const b = i * 5;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
  }).join(',');

  const params = deduped.flatMap(r => [r.symbol, r.company_name ?? r.symbol, r.datetime, r.pe ?? null, r.market_cap_cr ?? null]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity_new (symbol, company_name, datetime, pe, market_cap_cr)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO UPDATE SET
      pe            = COALESCE(EXCLUDED.pe,            nse_equity_new.pe),
      market_cap_cr = COALESCE(EXCLUDED.market_cap_cr, nse_equity_new.market_cap_cr)
  `, ...params);
}

/**
 * Upsert a batch of parsed OHLCV or valuation records.
 * @param {Array}  rows - Parsed records from prowessApiClient
 * @param {'ohlcv'|'valuation'} type
 */
async function upsertBatch(rows, type = 'ohlcv') {
  const fn = type === 'valuation' ? upsertValuationBatch : upsertOhlcvBatch;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await fn(rows.slice(i, i + BATCH_SIZE));
  }
  return rows.length;
}

module.exports = { upsertBatch };
