import { LRUCache } from "lru-cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notify dedup LRU", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDedup(max = 2) {
    return new LRUCache<string, true>({
      max,
      ttl: 3_600_000,
      ttlResolution: 0,
      ttlAutopurge: true,
      perf: { now: () => Date.now() },
    });
  }

  it("entry is present immediately after set", () => {
    const dedup = makeDedup();
    dedup.set("k1", true);
    expect(dedup.has("k1")).toBe(true);
  });

  it("absent key returns false", () => {
    const dedup = makeDedup();
    expect(dedup.has("never-set")).toBe(false);
  });

  it("TTL: entry expires after 1h + 1ms", () => {
    const dedup = makeDedup();
    dedup.set("ttl-key", true);
    expect(dedup.has("ttl-key")).toBe(true);

    vi.advanceTimersByTime(3_600_001);

    expect(dedup.has("ttl-key")).toBe(false);
  });

  it("TTL boundary: entry still present at 1h - 1ms", () => {
    const dedup = makeDedup();
    dedup.set("boundary-key", true);

    vi.advanceTimersByTime(3_599_999);

    expect(dedup.has("boundary-key")).toBe(true);
  });

  it("LRU capacity: cap=2 — 3rd entry evicts oldest", () => {
    const dedup = makeDedup(2);
    dedup.set("k1", true);
    dedup.set("k2", true);
    dedup.set("k3", true);

    expect(dedup.has("k1")).toBe(false);
    expect(dedup.has("k2")).toBe(true);
    expect(dedup.has("k3")).toBe(true);
  });

  it("two independent instances do not share state", () => {
    const slack = makeDedup();
    const telegram = makeDedup();

    slack.set("shared-key", true);

    // Each channel holds its own LRUCache — Telegram must not see Slack's entries.
    expect(slack.has("shared-key")).toBe(true);
    expect(telegram.has("shared-key")).toBe(false);
  });
});
