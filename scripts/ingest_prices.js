/**
 * Fetches daily OHLCV data from Yahoo Finance for all symbols in earnings_calls
 * and inserts missing dates into nse_equity.
 *
 * Usage:
 *   node scripts/ingest_prices.js            # full run
 *   node scripts/ingest_prices.js --dry-run  # single symbol, single day test
 */

const { default: YahooFinance } = require('yahoo-finance2');
const yahooFinance = new YahooFinance();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BATCH_SIZE = 10;           // symbols per batch
const DELAY_MS = 1000;           // ms between batches to avoid rate limits
const START_DATE = '2021-01-01'; // how far back to fetch
const NSE_SUFFIX = '.NS';        // Yahoo Finance suffix for NSE stocks

const isDryRun = process.argv.includes('--dry-run');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getAllSymbols() {
  const rows = await prisma.$queryRaw`SELECT DISTINCT company FROM earnings_calls ORDER BY company`;
  return rows.map(r => r.company);
}

async function getExistingDates(symbol) {
  const rows = await prisma.$queryRaw`
    SELECT datetime::date::text as d FROM nse_equity WHERE symbol = ${symbol}
  `;
  return new Set(rows.map(r => r.d));
}

async function fetchYahooData(symbol, startDate) {
  const ticker = symbol + NSE_SUFFIX;
  try {
    const result = await yahooFinance.chart(ticker, {
      period1: startDate,
      period2: new Date().toISOString().split('T')[0],
      interval: '1d',
    });
    return result?.quotes ?? [];
  } catch (err) {
    // Some symbols may not exist on Yahoo Finance
    if (err.message?.includes('No fundamentals data') || err.type === 'invalid_argument') {
      return null; // symbol not found
    }
    throw err;
  }
}

async function ingestSymbol(symbol, existingDates, dryRun = false) {
  const startDate = dryRun
    ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // last 2 days
    : START_DATE;

  const quotes = await fetchYahooData(symbol, startDate);

  if (quotes === null) {
    return { symbol, status: 'not_found', inserted: 0 };
  }

  if (!quotes.length) {
    return { symbol, status: 'no_data', inserted: 0 };
  }

  const toInsert = quotes.filter(q => {
    if (!q.date || q.close == null) return false;
    const dateStr = new Date(q.date).toISOString().split('T')[0];
    return !existingDates.has(dateStr);
  });

  if (dryRun) {
    console.log(`[DRY RUN] ${symbol}: ${quotes.length} quotes fetched, ${toInsert.length} new rows would be inserted`);
    if (toInsert.length > 0) {
      const q = toInsert[toInsert.length - 1];
      console.log(`[DRY RUN] Sample row:`, {
        symbol,
        datetime: new Date(q.date).toISOString().split('T')[0],
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      });
    }
    return { symbol, status: 'dry_run', inserted: toInsert.length };
  }

  if (!toInsert.length) {
    return { symbol, status: 'up_to_date', inserted: 0 };
  }

  // Batch insert in chunks of 500 to avoid query size limits
  const INSERT_CHUNK = 500;
  let totalInserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(q => ({
      symbol,
      datetime: new Date(q.date),
      open: q.open ?? 0,
      high: q.high ?? 0,
      low: q.low ?? 0,
      close: q.close,
      volume: BigInt(q.volume ?? 0),
    }));
    await prisma.nse_equity.createMany({ data: values, skipDuplicates: true });
    totalInserted += chunk.length;
  }

  return { symbol, status: 'inserted', inserted: totalInserted };
}

async function main() {
  console.log(`Starting price ingestion — mode: ${isDryRun ? 'DRY RUN' : 'FULL RUN'}`);

  let symbols = await getAllSymbols();
  console.log(`Total unique symbols in earnings_calls: ${symbols.length}`);

  if (isDryRun) {
    // Just test one symbol end-to-end
    symbols = [symbols[0]];
    console.log(`Dry run: testing with symbol "${symbols[0]}"\n`);
  }

  const results = { inserted: 0, up_to_date: 0, not_found: 0, no_data: 0, errors: 0 };

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbols.length / BATCH_SIZE)}: [${batch.join(', ')}]`);

    await Promise.all(
      batch.map(async symbol => {
        try {
          const existingDates = isDryRun ? new Set() : await getExistingDates(symbol);
          const result = await ingestSymbol(symbol, existingDates, isDryRun);
          results[result.status] = (results[result.status] ?? 0) + 1;
          if (result.status === 'inserted') {
            results.inserted += result.inserted; // accumulate row count
            console.log(`  ✓ ${symbol}: inserted ${result.inserted} rows`);
          } else if (result.status !== 'up_to_date') {
            console.log(`  ~ ${symbol}: ${result.status}`);
          }
        } catch (err) {
          results.errors++;
          console.error(`  ✗ ${symbol}: ${err.message}`);
        }
      })
    );

    if (!isDryRun && i + BATCH_SIZE < symbols.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Symbols processed : ${symbols.length}`);
  console.log(`Rows inserted     : ${results.inserted}`);
  console.log(`Up to date        : ${results.up_to_date}`);
  console.log(`Not found on YF   : ${results.not_found}`);
  console.log(`No data returned  : ${results.no_data}`);
  console.log(`Errors            : ${results.errors}`);

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('Fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
