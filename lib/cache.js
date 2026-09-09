'use strict';

const client = require('../config/cacheRedis');

/**
 * Cache utility for Quantcase backend.
 * Provides transparent cache-aside helpers, non-blocking pattern deletions,
 * and resilient fallbacks (falls back to DB seamlessly if Redis is offline).
 */

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

/**
 * Fetch a parsed JSON value from cache by key.
 * Returns null on miss, error, or disabled cache.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[cache] get failed for key "${key}":`, err.message);
    return null;
  }
}

/**
 * Store a JSON-serializable value in cache.
 * @param {string} key
 * @param {any} value
 * @param {number} [ttlSeconds=86400]
 * @returns {Promise<boolean>}
 */
async function set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!client || value === undefined) return false;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(key, serialized, 'EX', Math.floor(ttlSeconds));
    } else {
      await client.set(key, serialized);
    }
    return true;
  } catch (err) {
    console.warn(`[cache] set failed for key "${key}":`, err.message);
    return false;
  }
}

/**
 * Cache-aside helper: reads from cache, or runs fetchFn, caches result, and returns.
 * If Redis is unavailable or fails, executes fetchFn directly without throwing.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {() => Promise<T>} fetchFn
 * @returns {Promise<T>}
 */
async function getOrSet(key, ttlSeconds, fetchFn) {
  if (!client) {
    return fetchFn();
  }

  try {
    const cached = await get(key);
    if (cached !== null) {
      return cached;
    }
  } catch (err) {
    console.warn(`[cache] getOrSet read error for "${key}":`, err.message);
  }

  const freshData = await fetchFn();

  if (freshData !== undefined && freshData !== null) {
    set(key, freshData, ttlSeconds).catch((err) => {
      console.warn(`[cache] getOrSet async write error for "${key}":`, err.message);
    });
  }

  return freshData;
}

/**
 * Delete one or more specific keys.
 * @param {string|string[]} keys
 * @returns {Promise<number>}
 */
async function del(keys) {
  if (!client) return 0;
  const keyList = Array.isArray(keys) ? keys : [keys];
  if (keyList.length === 0) return 0;
  try {
    return await client.del(...keyList);
  } catch (err) {
    console.warn('[cache] del failed:', err.message);
    return 0;
  }
}

/**
 * Non-blocking deletion of keys matching a glob pattern using SCAN and pipelines.
 * Never blocks the Redis event loop.
 *
 * @param {string} pattern - e.g. "qc:stock:*:info"
 * @param {number} [batchSize=200]
 * @returns {Promise<number>} Total keys deleted
 */
async function delByPattern(pattern, batchSize = 200) {
  if (!client) return 0;
  let cursor = '0';
  let totalDeleted = 0;

  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize);
      cursor = nextCursor;

      if (keys && keys.length > 0) {
        const pipeline = client.pipeline();
        for (const k of keys) {
          pipeline.del(k);
        }
        await pipeline.exec();
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    return totalDeleted;
  } catch (err) {
    console.warn(`[cache] delByPattern failed for pattern "${pattern}":`, err.message);
    return totalDeleted;
  }
}

/**
 * Cleanly disconnect the cache client (used during graceful shutdown).
 */
async function close() {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    // If quit fails, force disconnect
    client.disconnect();
  }
}

module.exports = {
  get,
  set,
  getOrSet,
  del,
  delByPattern,
  close,
  getClient: () => client,
  DEFAULT_TTL_SECONDS,
};
