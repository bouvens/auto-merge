import { LRUCache } from "lru-cache";

// Twin of src/webhook/dedup.ts but keyed by (owner, repo, source_sha) to catch logical re-triggers across delivery_ids (D-18, TRIG-04). Thunk perf picks up Date.now replacements (e.g. test fake-timers) at call time; ttlResolution:0 disables the debounce cache so every staleness check reads the live clock; ttlAutopurge frees write-once expired entries without a get().
const cache = new LRUCache<string, true>({
  max: 5_000,
  ttl: 10 * 60 * 1000,
  ttlResolution: 0,
  ttlAutopurge: true,
  perf: { now: () => Date.now() },
});

export const sourceShaDedup = {
  seen: (id: string): boolean => cache.has(id),
  mark: (id: string): void => {
    cache.set(id, true);
  },
};
