'use strict';

const Redis = require('ioredis');
const env   = require('./env');

/**
 * Dedicated Redis client for application data caching.
 * Kept strictly isolated from config/redis.js (used by BullMQ queues and workers).
 */
let cacheConnection = null;

if (env.cacheRedisEnabled) {
  cacheConnection = new Redis({
    host:                 env.cacheRedisHost,
    port:                 env.cacheRedisPort,
    password:             env.cacheRedisPassword || undefined,
    lazyConnect:          true,
    enableOfflineQueue:   true,
    maxRetriesPerRequest: 3,
    connectTimeout:       5000,
    retryStrategy:        (times) => Math.min(times * 100, 3000),
  });

  cacheConnection.on('error', (err) => {
    console.error('[cache-redis] connection error:', err.message);
  });

  cacheConnection.on('connect', () => {
    console.log(`[cache-redis] connected to ${env.cacheRedisHost}:${env.cacheRedisPort}`);
  });

  // Connect eagerly in the background without blocking boot
  cacheConnection.connect().catch((err) => {
    console.warn(`[cache-redis] initial connection warning: ${err.message} (will retry on request)`);
  });
}

module.exports = cacheConnection;
