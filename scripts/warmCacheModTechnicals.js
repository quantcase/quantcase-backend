'use strict';

/**
 * scripts/warmCacheModTechnicals.js
 *
 * Ad-hoc cache warming script for Quantcase.
 * Pre-populates dedicated Redis cache with:
 *   - MOD analysis L3 (Management, Opportunity, Deal) -> qc:analysis:<TICKER>:l3:deal,management,opportunity
 *   - MOD analysis L4 (Summary Overview)             -> qc:analysis:<TICKER>:l4:summary
 *   - Technical Analysis & Decision Intelligence     -> qc:stock:<SYMBOL>:technicals
 *   - Technical Historical Prices (2Y OHLCV + SMAs)  -> qc:stock:<SYMBOL>:prices:2::
 *   - Company Header & Fundamentals Snapshot         -> qc:stock:<SYMBOL>:info
 *
 * Usage:
 *   node scripts/warmCacheModTechnicals.js                     # Warms default top ~25 active stocks
 *   node scripts/warmCacheModTechnicals.js INFY TCS RELIANCE   # Warms specific symbols
 *   node scripts/warmCacheModTechnicals.js --limit 50          # Warms top 50 stocks with MOD/Technicals
 *   node scripts/warmCacheModTechnicals.js --all               # Warms all stocks in DB (~732 with MOD)
 *   node scripts/warmCacheModTechnicals.js --mod-only          # Warms only MOD L3 & L4
 *   node scripts/warmCacheModTechnicals.js --technicals-only   # Warms only Technicals & Prices
 *   node scripts/warmCacheModTechnicals.js --status            # Check current Redis cache status
 */

// Allow early CLI overrides for Redis connection before requiring env / cacheRedis
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--redis-host' && process.argv[i + 1]) {
    process.env.CACHE_REDIS_HOST = process.argv[++i];
  } else if (process.argv[i] === '--redis-port' && process.argv[i + 1]) {
    process.env.CACHE_REDIS_PORT = process.argv[++i];
  } else if (process.argv[i] === '--redis-password' && process.argv[i + 1]) {
    process.env.CACHE_REDIS_PASSWORD = process.argv[++i];
  }
}

const prisma = require('../config/prisma');
const cache = require('../lib/cache');
const env = require('../config/env');
const postHtmlAnalysisService = require('../services/postHtmlAnalysis.service');
const technicalAnalysis = require('../lib/technicalAnalysis');
const screenerController = require('../controllers/screener.controller');

// Default top liquid/prominent stocks
const DEFAULT_TOP_STOCKS = [
  'HDFCBANK', 'RELIANCE', 'TCS', 'INFY', 'ICICIBANK',
  'TATAMOTORS', 'ITC', 'LT', 'SBIN', 'BHARTIARTL',
  'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'HCLTECH',
  'SUNPHARMA', 'TITAN', 'NTPC', 'TATACONSUM', 'POWERGRID',
  'ULTRACEMCO', 'ASIANPAINT', 'COALINDIA', 'JSWSTEEL', 'WIPRO',
  'ANGELONE', 'YESBANK', 'JIOFIN', 'INDIGO', 'COLPAL'
];

const L3_TYPES = ['deal', 'management', 'opportunity'];
const L3_TYPES_SORTED = 'deal,management,opportunity';

/**
 * Helper to invoke Express controller with mock req/res.
 */
function invokeController(fn, params = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { params, query };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      json(data) { resolve(data); return this; },
    };
    Promise.resolve(fn(req, res, (err) => {
      if (err) reject(err);
      else resolve(null);
    })).catch(reject);
  });
}

/**
 * Warm MOD analysis (L3: deal, management, opportunity & L4: summary).
 */
async function warmModAnalysis(ticker) {
  const sym = ticker.toUpperCase();
  const results = { l3: 0, l4: 0 };

  // L3 Combined & Individual
  try {
    const l3Rows = await postHtmlAnalysisService.getPostHtmlAnalysis(sym, 'l3', L3_TYPES);
    if (l3Rows && l3Rows.length > 0) {
      const l3Key = `qc:analysis:${sym}:l3:${L3_TYPES_SORTED}`;
      await cache.set(l3Key, l3Rows, 7 * 86400); // 7 days TTL
      results.l3 = l3Rows.length;

      // Also cache individual types so single tab clicks hit cache
      for (const row of l3Rows) {
        if (row.type) {
          const singleKey = `qc:analysis:${sym}:l3:${row.type.toLowerCase()}`;
          await cache.set(singleKey, [row], 7 * 86400);
        }
      }
    }
  } catch (err) {
    results.l3Error = err.message;
  }

  // L4 Summary Overview
  try {
    const l4Rows = await postHtmlAnalysisService.getPostHtmlAnalysis(sym, 'l4', ['summary']);
    if (l4Rows && l4Rows.length > 0) {
      const l4Key = `qc:analysis:${sym}:l4:summary`;
      await cache.set(l4Key, l4Rows, 7 * 86400); // 7 days TTL
      results.l4 = l4Rows.length;
    }
  } catch (err) {
    results.l4Error = err.message;
  }

  return results;
}

/**
 * Warm Technicals Decision Intelligence & RuleEngine payload.
 */
async function warmTechnicals(symbol) {
  const sym = symbol.toUpperCase();
  const cacheKey = `qc:stock:${sym}:technicals`;

  try {
    const result = await technicalAnalysis.analyze(sym);
    if (!result || !result.price) {
      return { status: 'NO_PRICE', key: cacheKey };
    }

    const dbInsight = await prisma.aiInsight.findFirst({
      where: { ticker: sym, type: 'technicals' },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }, { updated_at: 'desc' }],
    });

    if (dbInsight?.insight) {
      result.decisionIntelligence = dbInsight.insight;
      result.insightStatus = 'ready';
      result.insightUpdatedAt = dbInsight.updated_at;
      result.insightJob = null;
    } else {
      result.decisionIntelligence = null;
      result.insightUpdatedAt = null;
      result.insightJob = null;
      result.insightStatus = 'generating';
    }

    // Strip joined watchout strings from ruleEngine (matching screener.controller.js)
    if (result.ruleEngine) {
      const re = result.ruleEngine;
      const buckets = [
        re.structureEngine?.marketStructure,
        re.structureEngine?.participation,
        re.structureEngine?.priceStructure,
        re.trendEngine?.trendQuality,
        re.timingEngine?.momentum,
        re.timingEngine?.volatility,
        re.dominanceEngine?.leadership?.vsNifty,
        re.dominanceEngine?.leadership?.vsSector,
      ];
      for (const bucket of buckets) {
        if (!bucket) continue;
        delete bucket.growthWatchout;
        delete bucket.valueWatchout;
      }
    }

    if (result.insightStatus === 'ready') {
      await cache.set(cacheKey, result, 86400); // 24 hours TTL
      return { status: 'CACHED', cmp: result.price?.cmp, key: cacheKey };
    } else {
      return { status: 'NO_INSIGHT_IN_DB', key: cacheKey };
    }
  } catch (err) {
    return { status: 'ERROR', error: err.message, key: cacheKey };
  }
}

/**
 * Warm Technical Historical Prices (2Y OHLCV + indicators + SMAs).
 */
async function warmPrices(symbol) {
  const sym = symbol.toUpperCase();
  const cacheKey = `qc:stock:${sym}:prices:2::`;

  try {
    const data = await invokeController(screenerController.getPrices, { symbol: sym }, {});
    if (data && data.prices) {
      return { status: 'CACHED', count: data.count, key: cacheKey };
    }
    return { status: 'NO_DATA', key: cacheKey };
  } catch (err) {
    return { status: 'ERROR', error: err.message, key: cacheKey };
  }
}

/**
 * Warm Company Header & Fundamentals Snapshot.
 */
async function warmTickerInfo(symbol) {
  const sym = symbol.toUpperCase();
  const cacheKey = `qc:stock:${sym}:info`;

  try {
    const data = await invokeController(screenerController.getTickerInfo, { symbol: sym }, {});
    if (data && data.company) {
      return { status: 'CACHED', key: cacheKey };
    }
    return { status: 'NO_DATA', key: cacheKey };
  } catch (err) {
    return { status: 'ERROR', error: err.message, key: cacheKey };
  }
}

/**
 * Inspect Redis cache status.
 */
async function checkRedisStatus() {
  const client = cache.getClient();
  if (!client) {
    console.error('Cache Redis client is not initialized (CACHE_REDIS_ENABLED is false).');
    return;
  }

  console.log(`\n======================================================`);
  console.log(`          QUANTCASE REDIS CACHE STATUS               `);
  console.log(`======================================================`);
  console.log(`Host: ${env.cacheRedisHost}:${env.cacheRedisPort}`);

  try {
    const ping = await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 2000)),
    ]);
    console.log(`Connection: ACTIVE (PING -> ${ping})`);

    const info = await client.info('memory');
    const usedMemory = info.match(/used_memory_human:([^\r\n]+)/)?.[1] || 'N/A';
    const peakMemory = info.match(/used_memory_peak_human:([^\r\n]+)/)?.[1] || 'N/A';
    const maxMemory  = info.match(/maxmemory_human:([^\r\n]+)/)?.[1] || '0 (unlimited)';
    console.log(`Memory: Used=${usedMemory} | Peak=${peakMemory} | Max=${maxMemory}`);

    // Scan patterns
    const patterns = [
      { name: 'MOD Analysis (qc:analysis:*)', pattern: 'qc:analysis:*' },
      { name: 'Technicals (qc:stock:*:technicals)', pattern: 'qc:stock:*:technicals' },
      { name: 'Prices Series (qc:stock:*:prices:*)', pattern: 'qc:stock:*:prices:*' },
      { name: 'Company Info (qc:stock:*:info)', pattern: 'qc:stock:*:info' },
      { name: 'Tickers List (qc:tickers:*)', pattern: 'qc:tickers:*' },
      { name: 'Baskets (qc:baskets:*)', pattern: 'qc:baskets:*' },
    ];

    console.log(`\nCache Key Counts:`);
    for (const p of patterns) {
      let cursor = '0';
      let count = 0;
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', p.pattern, 'COUNT', 500);
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      console.log(`  - ${p.name.padEnd(38)} : ${count} keys`);
    }
    console.log(`======================================================\n`);
  } catch (err) {
    console.error(`Failed to inspect Redis:`, err.message);
  }
}

/**
 * Main execution routine.
 */
async function main() {
  const args = process.argv.slice(2);

  // Check if --status / --check requested
  if (args.includes('--status') || args.includes('--check')) {
    await checkRedisStatus();
    await cache.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  // Parse mode & flags
  const modOnly = args.includes('--mod-only');
  const technicalsOnly = args.includes('--technicals-only');
  const skipPrices = args.includes('--no-prices');
  const skipInfo = args.includes('--no-info');
  const warmAll = args.includes('--all');

  let limit = null;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  let concurrency = 2;
  const concIdx = args.indexOf('--concurrency');
  if (concIdx !== -1 && args[concIdx + 1]) {
    concurrency = Math.max(1, Math.min(10, parseInt(args[concIdx + 1], 10)));
  }

  // Determine tickers to process
  let explicitTickers = args.filter(a => !a.startsWith('--') && isNaN(parseInt(a, 10)));
  let targetTickers = [];

  if (explicitTickers.length > 0) {
    targetTickers = [...new Set(explicitTickers.map(t => t.toUpperCase()))];
    console.log(`[WarmCache] Using ${targetTickers.length} explicitly provided ticker(s): ${targetTickers.join(', ')}`);
  } else if (warmAll || limit !== null) {
    console.log(`[WarmCache] Fetching distinct tickers from DB...`);
    const dbTickers = await prisma.postHtmlAnalysis.findMany({
      select: { ticker: true },
      distinct: ['ticker'],
      orderBy: { ticker: 'asc' },
      ...(limit ? { take: limit } : {}),
    });
    targetTickers = dbTickers.map(t => t.ticker.toUpperCase());
    console.log(`[WarmCache] Loaded ${targetTickers.length} ticker(s) from DB.`);
  } else {
    targetTickers = DEFAULT_TOP_STOCKS;
    console.log(`[WarmCache] Using default curated list of ${targetTickers.length} liquid stocks.`);
  }

  const client = cache.getClient();
  if (client) {
    try {
      await client.ping();
      console.log(`[WarmCache] Connected to Cache Redis (${env.cacheRedisHost}:${env.cacheRedisPort})`);
    } catch (err) {
      console.warn(`[WarmCache] Warning: Cache Redis connection failed: ${err.message}. Running in fallback mode.`);
    }
  }

  console.log(`[WarmCache] Plan:`);
  console.log(`  - Target stocks: ${targetTickers.length}`);
  console.log(`  - MOD Analysis (L3 & L4): ${technicalsOnly ? 'OFF' : 'ON'}`);
  console.log(`  - Technicals Analysis:   ${modOnly ? 'OFF' : 'ON'}`);
  console.log(`  - Price Series (2Y):      ${modOnly || skipPrices ? 'OFF' : 'ON'}`);
  console.log(`  - Stock Info Header:     ${modOnly || skipInfo ? 'OFF' : 'ON'}`);
  console.log(`  - Concurrency:           ${concurrency}`);
  console.log(`--------------------------------------------------------------------------------`);

  const summary = {
    total: targetTickers.length,
    processed: 0,
    modL3: 0,
    modL4: 0,
    technicals: 0,
    prices: 0,
    info: 0,
    errors: 0,
    startTime: Date.now(),
  };

  // Worker task for a single ticker
  async function processTicker(ticker, index) {
    const t0 = Date.now();
    const prefix = `[${index + 1}/${targetTickers.length}] ${ticker.padEnd(10)}`;
    const logParts = [];

    try {
      // 1. MOD Analysis
      if (!technicalsOnly) {
        const modRes = await warmModAnalysis(ticker);
        if (modRes.l3 > 0) summary.modL3++;
        if (modRes.l4 > 0) summary.modL4++;
        logParts.push(`MOD: L3(${modRes.l3})${modRes.l3 > 0 ? '✓' : '-'} L4(${modRes.l4})${modRes.l4 > 0 ? '✓' : '-'}`);
      }

      // 2. Technicals
      if (!modOnly) {
        const techRes = await warmTechnicals(ticker);
        if (techRes.status === 'CACHED') {
          summary.technicals++;
          logParts.push(`Tech(CMP:${techRes.cmp})✓`);
        } else {
          logParts.push(`Tech(${techRes.status})`);
        }
      }

      // 3. Prices
      if (!modOnly && !skipPrices) {
        const priceRes = await warmPrices(ticker);
        if (priceRes.status === 'CACHED') {
          summary.prices++;
          logParts.push(`Prices(${priceRes.count})✓`);
        } else {
          logParts.push(`Prices(${priceRes.status})`);
        }
      }

      // 4. Info
      if (!modOnly && !skipInfo) {
        const infoRes = await warmTickerInfo(ticker);
        if (infoRes.status === 'CACHED') {
          summary.info++;
          logParts.push(`Info✓`);
        } else {
          logParts.push(`Info(${infoRes.status})`);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${prefix}: ${logParts.join(' | ')} (${elapsed}s)`);
      summary.processed++;
    } catch (err) {
      summary.errors++;
      console.error(`${prefix}: FAILED - ${err.message}`);
    }
  }

  // Queue runner with bounded concurrency
  let queueIndex = 0;
  async function worker() {
    while (queueIndex < targetTickers.length) {
      const idx = queueIndex++;
      await processTicker(targetTickers[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalTime = ((Date.now() - summary.startTime) / 1000).toFixed(1);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[WarmCache] Finished processing ${summary.processed}/${summary.total} stocks in ${totalTime}s`);
  console.log(`  - MOD L3 keys cached:    ${summary.modL3}`);
  console.log(`  - MOD L4 keys cached:    ${summary.modL4}`);
  console.log(`  - Technicals cached:     ${summary.technicals}`);
  console.log(`  - Prices series cached:  ${summary.prices}`);
  console.log(`  - Stock Info cached:     ${summary.info}`);
  if (summary.errors > 0) {
    console.log(`  - Errors encountered:    ${summary.errors}`);
  }

  // Print Redis stats after warming
  await checkRedisStatus();
}

main()
  .catch((err) => {
    console.error('[WarmCache] Fatal error:', err);
  })
  .finally(async () => {
    try {
      await cache.close();
    } catch {}
    try {
      await prisma.$disconnect();
    } catch {}
    process.exit(0);
  });
