'use strict';

const asyncHandler = require('../middleware/asyncHandler');
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

/**
 * Scan Redis keys matching a pattern without blocking.
 */
async function countKeys(client, pattern) {
  let cursor = '0';
  let count = 0;
  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  } catch (err) {
    return 0;
  }
}

/**
 * GET /admin/cache/stats
 */
const getStats = asyncHandler(async (req, res) => {
  const client = cache.getClient();
  if (!client) {
    return res.json({
      success: true,
      connected: false,
      message: 'Redis cache is disabled or client not initialized',
      host: env.cacheRedisHost || 'N/A',
      port: env.cacheRedisPort || 6379,
    });
  }

  try {
    const ping = await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 2500)),
    ]);

    const info = await client.info('memory');
    const usedMemory = info.match(/used_memory_human:([^\r\n]+)/)?.[1] || 'N/A';
    const peakMemory = info.match(/used_memory_peak_human:([^\r\n]+)/)?.[1] || 'N/A';
    const maxMemory  = info.match(/maxmemory_human:([^\r\n]+)/)?.[1] || '0 (unlimited)';

    // Scan counts for each pattern concurrently
    const keyCounts = {};
    await Promise.all(
      PATTERNS.map(async (p) => {
        keyCounts[p.key] = {
          name: p.name,
          pattern: p.pattern,
          count: await countKeys(client, p.pattern),
        };
      })
    );

    res.json({
      success: true,
      connected: ping === 'PONG',
      host: env.cacheRedisHost || '127.0.0.1',
      port: env.cacheRedisPort || 6379,
      memory: {
        used: usedMemory,
        peak: peakMemory,
        max: maxMemory,
      },
      keyCounts,
      warming: cacheWarmer.getWarmingState(),
    });
  } catch (err) {
    res.json({
      success: true,
      connected: false,
      message: err.message,
      host: env.cacheRedisHost || 'N/A',
      port: env.cacheRedisPort || 6379,
    });
  }
});

/**
 * POST /admin/cache/invalidate
 * Body: { scope?: string, ticker?: string, pattern?: string }
 */
const invalidateCache = asyncHandler(async (req, res) => {
  const { scope = 'all', ticker, pattern } = req.body;
  const sym = ticker ? ticker.toUpperCase().trim() : null;
  let deletedCount = 0;

  if (pattern) {
    // Custom pattern (must start with qc:)
    const sanitized = pattern.startsWith('qc:') ? pattern : `qc:${pattern}`;
    deletedCount = await cache.delByPattern(sanitized);
    return res.json({
      success: true,
      message: `Deleted ${deletedCount} key(s) matching "${sanitized}"`,
      deletedCount,
      pattern: sanitized,
    });
  }

  if (sym) {
    // Ticker-specific invalidation
    const patternsToDelete = [];

    if (scope === 'all' || scope === 'ticker') {
      patternsToDelete.push(`qc:stock:${sym}:*`);
      patternsToDelete.push(`qc:analysis:${sym}:*`);
      patternsToDelete.push(`qc:lenses:${sym}:*`);
    } else if (scope === 'financials') {
      patternsToDelete.push(`qc:stock:${sym}:financials*`);
    } else if (scope === 'charts') {
      patternsToDelete.push(`qc:stock:${sym}:charts:*`);
    } else if (scope === 'shareholding') {
      patternsToDelete.push(`qc:stock:${sym}:shareholding*`);
    } else if (scope === 'peers') {
      patternsToDelete.push(`qc:stock:${sym}:peers`);
    } else if (scope === 'technicals') {
      patternsToDelete.push(`qc:stock:${sym}:technicals*`);
    } else if (scope === 'mod') {
      patternsToDelete.push(`qc:analysis:${sym}:*`);
    } else if (scope === 'lenses') {
      patternsToDelete.push(`qc:lenses:${sym}:*`);
    } else if (scope === 'prices') {
      patternsToDelete.push(`qc:stock:${sym}:prices:*`);
    } else if (scope === 'info') {
      patternsToDelete.push(`qc:stock:${sym}:info`);
    }

    const counts = await Promise.all(patternsToDelete.map((p) => cache.delByPattern(p)));
    deletedCount = counts.reduce((sum, c) => sum + (typeof c === 'number' ? c : 0), 0);

    return res.json({
      success: true,
      message: `Invalidated ${deletedCount} cache key(s) for ticker "${sym}" (scope: ${scope})`,
      deletedCount,
      ticker: sym,
      scope,
    });
  }

  // Domain-wide invalidation across all tickers
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

  const targetPatterns = domainPatterns[scope.toLowerCase()] || [`qc:*${scope}*`];
  const counts = await Promise.all(targetPatterns.map((p) => cache.delByPattern(p)));
  deletedCount = counts.reduce((sum, c) => sum + (typeof c === 'number' ? c : 0), 0);

  res.json({
    success: true,
    message: `Invalidated ${deletedCount} cache key(s) for scope "${scope}"`,
    deletedCount,
    scope,
  });
});

/**
 * POST /admin/cache/warm
 * Body: { tickers?: string[], top?: number, domains?: string[], concurrency?: number }
 */
const warmCache = asyncHandler(async (req, res) => {
  const { tickers: requestedTickers, top, domains, concurrency } = req.body;
  let tickers = [];

  if (Array.isArray(requestedTickers) && requestedTickers.length > 0) {
    tickers = requestedTickers.map((t) => String(t).toUpperCase().trim()).filter(Boolean);
  } else {
    // Default to top market cap companies from prowess_identity or active symbols
    const limit = top && Number(top) > 0 ? Number(top) : 20;
    try {
      const dbTickers = await prisma.companyGroup.findFirst({
        where: { slug: 'nifty-50' },
      });
      if (dbTickers?.filter_config?.tickers?.length) {
        tickers = dbTickers.filter_config.tickers.slice(0, limit);
      }
    } catch (_) {}

    if (tickers.length === 0) {
      // Fallback top liquid tickers
      tickers = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'TITAN', 'MARUTI'].slice(0, limit);
    }
  }

  // Kick off background warming
  cacheWarmer.warmBatch(tickers, {
    domains: domains || cacheWarmer.ALL_DOMAINS,
    concurrency: concurrency || 2,
  }).catch((err) => {
    console.error('[admin.cache.controller] Background warmBatch error:', err.message);
  });

  res.status(202).json({
    success: true,
    message: `Started background cache warming for ${tickers.length} ticker(s)`,
    tickers,
    domains: domains || cacheWarmer.ALL_DOMAINS,
  });
});

/**
 * GET /admin/cache/warming-status
 */
const getWarmingStatus = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    warming: cacheWarmer.getWarmingState(),
  });
});

module.exports = {
  getStats,
  invalidateCache,
  warmCache,
  getWarmingStatus,
};
