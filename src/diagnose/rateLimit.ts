import { LRUCache } from "lru-cache";

export interface DiagnoseRateLimitOptions {
  max?: number;
  windowMs?: number;
}

export interface DiagnoseRateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export interface DiagnoseRateLimit {
  check(ip: string): DiagnoseRateLimitResult;
}

interface Entry {
  count: number;
  resetAt: number;
}

const HARD_CAP_PER_WINDOW = 10;

export function createDiagnoseRateLimit(opts: DiagnoseRateLimitOptions = {}): DiagnoseRateLimit {
  const max = opts.max ?? 10_000;
  const windowMs = opts.windowMs ?? 60_000;

  // LRU bounds attacker-controlled IP cardinality; ttlResolution:0 reads live clock so fake-timer tests stay deterministic.
  const cache = new LRUCache<string, Entry>({
    max,
    ttl: windowMs,
    ttlAutopurge: true,
    ttlResolution: 0,
  });

  return {
    check(ip: string): DiagnoseRateLimitResult {
      const now = Date.now();
      const entry = cache.get(ip);
      if (!entry || now >= entry.resetAt) {
        cache.set(ip, { count: 1, resetAt: now + windowMs });
        return { allowed: true };
      }
      if (entry.count >= HARD_CAP_PER_WINDOW) {
        return {
          allowed: false,
          retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
        };
      }
      entry.count += 1;
      return { allowed: true };
    },
  };
}
