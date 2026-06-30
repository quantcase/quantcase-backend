'use strict';

const { fetchOhlcv }   = require('../../services/prowess/prowessApiClient');
const { upsertBatch }  = require('../../services/prowess/prowessOhlcvIngester');

async function run(config = {}) {
  const lookbackDays = config.lookback_days ?? 1;
  const date = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`[prowess-ohlcv] Fetching OHLCV from ${date}`);
  const rows = await fetchOhlcv(date);
  console.log(`[prowess-ohlcv] Fetched ${rows.length} rows`);

  const n = await upsertBatch(rows, 'ohlcv');
  return { records_processed: n };
}

module.exports = { run };
