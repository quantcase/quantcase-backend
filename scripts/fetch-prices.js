/**
 * Fetch historical price data from Yahoo Finance and upsert into nse_equity table.
 *
 * Usage:
 *   node scripts/fetch-prices.js                        # fetch all DEFAULT_SYMBOLS
 *   node scripts/fetch-prices.js COHANCE ZENTEC         # fetch specific symbols
 *   node scripts/fetch-prices.js --from 2020-01-01 COHANCE  # custom start date
 */

const YahooFinance = require('yahoo-finance2').default;
const { PrismaClient } = require('@prisma/client');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_FROM_DATE = '2021-01-01';

const DEFAULT_SYMBOLS = [
  'MSUMI',
  'COHANCE',
  'ZENTEC',
  'SHAKTIPUMP',
  'AURIONPRO',
  'EPIGRAL',
];
// ─────────────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function fetchSymbol(symbol, fromDate) {
  const yahooSymbol = `${symbol}.NS`;
  console.log(`\nFetching ${yahooSymbol} from ${fromDate}...`);

  const result = await yahooFinance.chart(yahooSymbol, {
    period1: fromDate,
    interval: '1d',
  });

  const quotes = result.quotes;
  console.log(`  Fetched ${quotes.length} records from Yahoo Finance.`);

  let upserted = 0;
  let skipped = 0;

  for (const q of quotes) {
    if (q.close == null) {
      skipped++;
      continue;
    }

    const datetime = new Date(q.date);

    await prisma.nse_equity.upsert({
      where: { symbol_datetime: { symbol, datetime } },
      update: {
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        close: q.close,
        volume: q.volume != null ? BigInt(q.volume) : null,
      },
      create: {
        symbol,
        datetime,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        close: q.close,
        volume: q.volume != null ? BigInt(q.volume) : null,
      },
    });

    upserted++;
  }

  console.log(`  Done. Upserted: ${upserted}, Skipped (null close): ${skipped}`);
}

async function main() {
  const args = process.argv.slice(2);

  let fromDate = DEFAULT_FROM_DATE;
  const symbols = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      fromDate = args[++i];
    } else {
      symbols.push(args[i].toUpperCase());
    }
  }

  const targetSymbols = symbols.length > 0 ? symbols : DEFAULT_SYMBOLS;
  console.log(`Fetching prices for: ${targetSymbols.join(', ')}`);
  console.log(`Start date: ${fromDate}`);

  for (const symbol of targetSymbols) {
    try {
      await fetchSymbol(symbol, fromDate);
    } catch (err) {
      console.error(`  ERROR for ${symbol}:`, err.message);
    }
  }

  console.log('\nAll done.');
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
