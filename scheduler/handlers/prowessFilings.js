'use strict';

const { fetchQuarterlyFilings, fetchAnnualFilings } = require('../../services/prowess/prowessApiClient');
const { upsert } = require('../../services/prowess/prowessFilingsIngester');

async function run(config = {}, jobType = 'prowess_quarterly') {
  const lookbackDays = config.lookback_days ?? 7;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const isAnnual = jobType === 'prowess_annual';

  console.log(`[prowess-filings] Fetching ${isAnnual ? 'annual' : 'quarterly'} filings since ${since.toISOString().slice(0, 10)}`);

  const rows = isAnnual
    ? await fetchAnnualFilings(since)
    : await fetchQuarterlyFilings(since);

  console.log(`[prowess-filings] Fetched ${rows.length} rows`);
  const n = await upsert(rows, isAnnual ? 'annual' : 'quarterly');
  return { records_processed: n };
}

module.exports = { run };
