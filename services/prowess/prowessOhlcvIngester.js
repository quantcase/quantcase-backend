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
    const b = i * 14;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},now(),now())`;
  }).join(',');

  const params = rows.flatMap(r => [
    r.symbol, r.company_name ?? r.symbol, r.datetime, r.open, r.high, r.low, r.close,
    r.volume ?? null, r.pe ?? null, r.eps ?? null, r.market_cap_cr ?? null, r.pct_change ?? null,
    r.pe_consolidated ?? null, r.pe_standalone ?? null,
  ]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity_new (symbol, company_name, datetime, open, high, low, close, volume, pe, eps, market_cap_cr, pct_change, pe_consolidated, pe_standalone, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO UPDATE SET
      open            = COALESCE(EXCLUDED.open,            nse_equity_new.open),
      high            = COALESCE(EXCLUDED.high,            nse_equity_new.high),
      low             = COALESCE(EXCLUDED.low,             nse_equity_new.low),
      close           = COALESCE(EXCLUDED.close,           nse_equity_new.close),
      volume          = COALESCE(EXCLUDED.volume,          nse_equity_new.volume),
      market_cap_cr   = COALESCE(EXCLUDED.market_cap_cr,   nse_equity_new.market_cap_cr),
      pct_change      = COALESCE(EXCLUDED.pct_change,      nse_equity_new.pct_change),
      pe_consolidated = COALESCE(EXCLUDED.pe_consolidated, nse_equity_new.pe_consolidated),
      pe_standalone   = COALESCE(EXCLUDED.pe_standalone,   nse_equity_new.pe_standalone),
      updated_at      = now()
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
    if (r.pe              != null) ex.pe              = r.pe;
    if (r.market_cap_cr    != null) ex.market_cap_cr   = r.market_cap_cr;
    if (r.pe_consolidated != null) ex.pe_consolidated = r.pe_consolidated;
    if (r.pe_standalone   != null) ex.pe_standalone   = r.pe_standalone;
  }
  const deduped = Array.from(seen.values());

  const values = deduped.map((_, i) => {
    const b = i * 7;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},now(),now())`;
  }).join(',');

  const params = deduped.flatMap(r => [
    r.symbol, r.company_name ?? r.symbol, r.datetime, r.pe ?? null, r.market_cap_cr ?? null,
    r.pe_consolidated ?? null, r.pe_standalone ?? null,
  ]);

  await prisma.$executeRawUnsafe(`
    INSERT INTO nse_equity_new (symbol, company_name, datetime, pe, market_cap_cr, pe_consolidated, pe_standalone, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT (symbol, datetime) DO UPDATE SET
      pe              = COALESCE(EXCLUDED.pe,              nse_equity_new.pe),
      market_cap_cr   = COALESCE(EXCLUDED.market_cap_cr,   nse_equity_new.market_cap_cr),
      pe_consolidated = COALESCE(EXCLUDED.pe_consolidated, nse_equity_new.pe_consolidated),
      pe_standalone   = COALESCE(EXCLUDED.pe_standalone,   nse_equity_new.pe_standalone),
      updated_at      = now()
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
