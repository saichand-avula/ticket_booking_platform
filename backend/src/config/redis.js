// ============================================================
// redis.js — Redis connection (Upstash)
//
// Uses ioredis to connect to Upstash Redis (or any Redis URL).
// Exports a reusable client singleton. The connection string
// comes from the REDIS_URL env var.
//
// Upstash free tier gives 10,000 commands/day which is plenty
// for development. In production, upgrade to a paid plan.
//
// USAGE:
//   const redis = require('./redis');
//   await redis.set('key', 'value', 'EX', 300);  // 5 min TTL
//   const val = await redis.get('key');
// ============================================================

const Redis = require('ioredis');

let redis;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    // Upstash requires TLS — ioredis handles this automatically
    // when the URL starts with 'rediss://' (note the double s).
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      // Exponential backoff: 200ms, 400ms, 800ms then stop.
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('connect', () => {
    console.log('✅ Redis connected');
  });

  redis.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
  });
} else {
  // If no REDIS_URL, create a stub that warns but doesn't crash.
  // This lets the backend start without Redis for other dev work.
  console.warn('⚠️  REDIS_URL not set — seat locking will not work');
  redis = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    exists: async () => 0,
    multi: () => ({
      set: function() { return this; },
      exec: async () => [],
    }),
    pipeline: () => ({
      get: function() { return this; },
      exec: async () => [],
    }),
  };
}

module.exports = redis;
