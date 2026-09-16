#!/usr/bin/env node
'use strict';

require('dotenv').config();

const cache = require('../lib/cache');
const env = require('../config/env');
const prisma = require('../config/prisma');
const cacheWarmer = require('../services/cacheWarmer.service');

const PATTERNS = [
  { key: 'financials', name: 'Financials Statements', pattern: 'qc:stock:*:financials*' },
  { key: 'charts', name: 'KPI Charts', pattern: 'qc:stock:*:charts:*' },
  { key: 'shareholding', name: 'Shareholding Patterns', pattern: 'qc:stock:*:shareholding*' },
  { key: 'peers', name: 'Industry Peers', pattern: 'qc:*peers*' },
  { key: 'technicals', name: 'Technical Indicators', pattern: 'qc:stock:*:technicals*' },
  { key: 'mod', name: 'MOD Analysis (L3 & L4)', pattern: 'qc:analysis:*' },
  { key: 'lenses', name: 'Lens Scores', pattern: 'qc:lenses:*' },
  { key: 'info', name: 'Company Info', pattern: 'qc:stock:*:info' },
  { key: 'prices', name: 'Historical Prices', pattern: 'qc:stock:*:prices:*' },
  { key: 'wyckoff', name: 'Wyckoff Analysis', pattern: 'qc:stock:*:wyckoff*' },
  { key: 'baskets', name: 'Baskets & Indices', pattern: 'qc:basket:*' },
  { key: 'tickers', name: 'Tickers List', pattern: 'qc:tickers:*' },
  { key: 'all', name: 'All Quantcase Caches', pattern: 'qc:*' },
];

function printHelp() {
  console.log(`
QuantCase Cache Manager CLI
Usage: node scripts/cacheManager.js [options]

Inspection:
  --status                    Display Redis connection, memory stats, and key counts.

Cleaning & Invalidation:
  --clean <scope>             Invalidate cache by scope.
                              Scopes: all, financials, charts, shareholding, peers,
                                      technicals, mod, lenses, prices, info, wyckoff, baskets
                              Example: node scripts/cacheManager.js --clean financials
                              Example: node scripts/cacheManager.js --clean all

  --clean-ticker <SYMBOL>     Invalidate all cache for a specific stock ticker.
                              Example: node scripts/cacheManager.js --clean-ticker INFY

Warming:
  --warm                      Trigger cache warming.
    --tickers <SYM1,SYM2,...> Specific comma-separated list of symbols to warm.
                              Example: node scripts/cacheManager.js --warm --tickers INFY,TCS,RELIANCE
    --top <N>                 Warm top N symbols (default: 20).
                              Example: node scripts/cacheManager.js --warm --top 50
    --domains <d1,d2,...>     Comma-separated domains to warm (default: all).
                              Available: info, financials, charts, shareholding,
                                         peers, technicals, mod, lenses, prices
    --concurrency <N>         Concurrent workers (default: 2, max: 6).

General:
  --help                      Show this help message.
`);
}

async function showStatus() {
  const client = cache.getClient();
  if (!client) {
    console.error('Cache Redis client is not initialized (CACHE_REDIS_ENABLED is false).');
    return;
  }

  console.log('\n======================================================');
  console.log('             QUANTCASE REDIS CACHE STATUS             ');
  console.log('======================================================');
  console.log(`Host: ${env.cacheRedisHost}:${env.cacheRedisPort}`);

  try {
    const ping = await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 3000)),
    ]);
    console.log(`Connection: ACTIVE (PING -> ${ping})`);

    const info = await client.info('memory');
    const usedMemory = info.match(/used_memory_human:([^\r\n]+)/)?.[1] || 'N/A';
    const peakMemory = info.match(/used_memory_peak_human:([^\r\n]+)/)?.[1] || 'N/A';
    const maxMemory  = info.match(/maxmemory_human:([^\r\n]+)/)?.[1] || '0 (unlimited)';
    console.log(`Memory: Used=${usedMemory} | Peak=${peakMemory} | Max=${maxMemory}`);

    console.log('\nCache Key Counts:');
    for (const p of PATTERNS) {
      let cursor = '0';
      let count = 0;
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', p.pattern, 'COUNT', 1000);
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      console.log(`  - ${p.name.padEnd(32)} (${p.pattern.padEnd(28)}) : ${count} keys`);
    }
    console.log('======================================================\n');
  } catch (err) {
    console.error('Failed to inspect Redis:', err.message);
  }
}

async function cleanCache(scope) {
  const s = String(scope || 'all').toLowerCase().trim();
  console.log(`\nInvalidating cache for scope: "${s}"...`);

  const domainPatterns = {
    all: ['qc:*'],
    financials: ['qc:stock:*:financials*'],
    charts: ['qc:stock:*:charts:*'],
    shareholding: ['qc:stock:*:shareholding*'],
    peers: ['qc:stock:*:peers', 'qc:peers:industry:*'],
    technicals: ['qc:stock:*:technicals*'],
    mod: ['qc:analysis:*'],
    lenses: ['qc:lenses:*'],
    prices: ['qc:stock:*:prices:*'],
    info: ['qc:stock:*:info'],
    wyckoff: ['qc:stock:*:wyckoff*'],
    baskets: ['qc:basket:*', 'qc:market:indices'],
    tickers: ['qc:tickers:*'],
  };

  const patterns = domainPatterns[s] || [`qc:*${s}*`];
  let totalDeleted = 0;

  for (const pat of patterns) {
    process.stdout.write(`  Deleting keys matching "${pat}"... `);
    const count = await cache.delByPattern(pat);
    console.log(`${count} deleted`);
    totalDeleted += count;
  }

  console.log(`Done! Total keys deleted: ${totalDeleted}\n`);
}

async function cleanTicker(symbol) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) {
    console.error('Error: Please provide a valid ticker symbol (e.g. --clean-ticker INFY)');
    return;
  }

  console.log(`\nInvalidating all cache keys for ticker "${sym}"...`);

  const patterns = [
    `qc:stock:${sym}:*`,
    `qc:analysis:${sym}:*`,
    `qc:lenses:${sym}:*`,
  ];

  let totalDeleted = 0;
  for (const pat of patterns) {
    process.stdout.write(`  Deleting keys matching "${pat}"... `);
    const count = await cache.delByPattern(pat);
    console.log(`${count} deleted`);
    totalDeleted += count;
  }

  console.log(`Done! Total keys deleted for ${sym}: ${totalDeleted}\n`);
}

async function warmCache(tickersArg, topArg, domainsArg, concurrencyArg) {
  let tickers = [];

  if (tickersArg) {
    tickers = tickersArg.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  } else {
    const limit = topArg && parseInt(topArg, 10) > 0 ? parseInt(topArg, 10) : 20;
    try {
      const dbTickers = await prisma.companyGroup.findFirst({
        where: { slug: 'nifty-50' },
      });
      if (dbTickers?.filter_config?.tickers?.length) {
        tickers = dbTickers.filter_config.tickers.slice(0, limit);
      }
    } catch (_) {}

    if (tickers.length === 0) {
      tickers = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'TITAN', 'MARUTI'].slice(0, limit);
    }
  }

  const domains = domainsArg
    ? domainsArg.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
    : cacheWarmer.ALL_DOMAINS;

  const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : 2;

  console.log(`\n======================================================`);
  console.log(`               CACHE WARMING STARTED                  `);
  console.log(`======================================================`);
  console.log(`Tickers (${tickers.length}): ${tickers.join(', ')}`);
  console.log(`Domains (${domains.length}): ${domains.join(', ')}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`======================================================\n`);

  const startTime = Date.now();

  const result = await cacheWarmer.warmBatch(tickers, {
    domains,
    concurrency,
    onProgress: ({ completed, total, symbol }) => {
      const pct = Math.round((completed / total) * 100);
      console.log(`[${completed}/${total}] (${pct}%) Warmed ${symbol}`);
    },
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n======================================================`);
  console.log(`Warming completed in ${durationSec}s!`);
  console.log(`Completed: ${result.completed}/${result.total}`);
  if (result.errors?.length > 0) {
    console.log(`Errors (${result.errors.length}):`);
    result.errors.forEach((e) => console.log(`  - ${e.symbol}: ${e.error}`));
  }
  console.log(`======================================================\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--status')) {
    await showStatus();
  }

  const cleanIdx = args.indexOf('--clean');
  if (cleanIdx !== -1) {
    const scope = args[cleanIdx + 1] && !args[cleanIdx + 1].startsWith('--') ? args[cleanIdx + 1] : 'all';
    await cleanCache(scope);
  }

  const cleanTickerIdx = args.indexOf('--clean-ticker');
  if (cleanTickerIdx !== -1) {
    const sym = args[cleanTickerIdx + 1];
    await cleanTicker(sym);
  }

  if (args.includes('--warm')) {
    let tickersArg = null;
    const tIdx = args.indexOf('--tickers');
    if (tIdx !== -1 && args[tIdx + 1]) tickersArg = args[tIdx + 1];

    let topArg = null;
    const topIdx = args.indexOf('--top');
    if (topIdx !== -1 && args[topIdx + 1]) topArg = args[topIdx + 1];

    let domainsArg = null;
    const dIdx = args.indexOf('--domains');
    if (dIdx !== -1 && args[dIdx + 1]) domainsArg = args[dIdx + 1];

    let concArg = null;
    const cIdx = args.indexOf('--concurrency');
    if (cIdx !== -1 && args[cIdx + 1]) concArg = args[cIdx + 1];

    await warmCache(tickersArg, topArg, domainsArg, concArg);
  }

  await cache.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error in cacheManager:', err);
  process.exit(1);
});
