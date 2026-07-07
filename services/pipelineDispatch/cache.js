'use strict';

// Minimal in-process TTL cache — deliberately not Redis. This is a
// single-process admin tool and the data underneath (job/signal state)
// already changes on the order of minutes, so a short in-memory TTL is
// enough to absorb duplicate/rapid-fire requests (an admin re-previewing
// after a small tweak, a double-click, two people pulling the same CSV
// around the same time) without adding an external dependency. The cache
// dies with the process (fine — it's disposable) and isn't shared across
// instances if the API ever runs behind more than one process, which is an
// accepted limitation for now.
class TtlCache {
  constructor() {
    this.store = new Map(); // key -> { value (or in-flight Promise), expiresAt }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Returns the cached value if present and fresh; otherwise calls fn(),
  // caches its resolved value, and returns it. The in-flight Promise itself
  // is cached too (not just the resolved value) — concurrent calls with the
  // same key while a fetch is still running share that one Promise instead
  // of each triggering their own duplicate query. A rejected fetch removes
  // its own cache entry rather than caching the failure.
  async wrap(key, ttlMs, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const promise = fn().catch(err => {
      this.store.delete(key);
      throw err;
    });
    this.set(key, promise, ttlMs);
    return promise;
  }
}

// Builds a stable cache key from an endpoint prefix + its options object —
// sorts top-level keys so equivalent option objects with different key
// order hash the same.
function cacheKey(prefix, options) {
  const sorted = Object.keys(options).sort().reduce((acc, k) => {
    acc[k] = options[k];
    return acc;
  }, {});
  return `${prefix}:${JSON.stringify(sorted)}`;
}

module.exports = { TtlCache, cacheKey };
