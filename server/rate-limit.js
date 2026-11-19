'use strict';

/** Fixed-window, in-memory rate limiter keyed by client address. Suitable for a single server process. */
function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();

  function sweep(time) {
    for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
  }

  return {
    check(key) {
      const time = now();
      if (hits.size > 5000) sweep(time);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= time) {
        entry = { count: 0, resetAt: time + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= max;
      return { allowed, retryAfterSeconds: allowed ? 0 : Math.ceil((entry.resetAt - time) / 1000) };
    },
  };
}

module.exports = { createRateLimiter };
