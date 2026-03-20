'use strict';

const Redis = require('ioredis');

/**
 * Shared Redis connection used by BullMQ workers and the JobQueue singleton.
 * Exported as a singleton to avoid opening redundant connections.
 */
const connection = new Redis({
  host:                 process.env.REDIS_HOST || 'localhost',
  port:                 process.env.REDIS_PORT || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  retryStrategy:        (times) => Math.min(times * 50, 20000),
});

module.exports = connection;
