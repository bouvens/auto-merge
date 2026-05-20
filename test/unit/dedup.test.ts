import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dedup } from "../../src/webhook/dedup.js";

describe("dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for an unknown id", () => {
    expect(dedup.seen("unknown-id-1")).toBe(false);
  });

  it("returns true after marking an id", () => {
    dedup.mark("delivery-abc");
    expect(dedup.seen("delivery-abc")).toBe(true);
  });

  it("TTL: entry expires after 10 minutes", () => {
    const id = `ttl-test-${Date.now()}`;
    dedup.mark(id);
    expect(dedup.seen(id)).toBe(true);

    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(dedup.seen(id)).toBe(false);
  });

  it("capacity: marking 10001 distinct ids evicts the oldest", () => {
    for (let i = 0; i < 10_001; i++) {
      dedup.mark(`capacity-test-${i}`);
    }
    // LRUCache evicts oldest on overflow — first entry should be gone
    expect(dedup.seen("capacity-test-0")).toBe(false);
    expect(dedup.seen("capacity-test-10000")).toBe(true);
  });
});
