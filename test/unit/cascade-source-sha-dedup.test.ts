import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceShaDedup } from "../../src/cascade/sourceShaDedup.js";

describe("sourceShaDedup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false before mark", () => {
    expect(sourceShaDedup.seen("acme/repo@sha-unknown-1")).toBe(false);
  });

  it("returns true immediately after mark", () => {
    const key = "acme/repo@sha-mark-1";
    sourceShaDedup.mark(key);
    expect(sourceShaDedup.seen(key)).toBe(true);
  });

  it("returns false for an unrelated key", () => {
    sourceShaDedup.mark("acme/repo@sha-isolated-1");
    expect(sourceShaDedup.seen("acme/repo@sha-isolated-2")).toBe(false);
    expect(sourceShaDedup.seen("other/repo@sha-isolated-1")).toBe(false);
  });

  it("TTL: entry expires after 10 minutes + 1ms", () => {
    const key = `acme/repo@ttl-expire-${Date.now()}`;
    sourceShaDedup.mark(key);
    expect(sourceShaDedup.seen(key)).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(sourceShaDedup.seen(key)).toBe(false);
  });

  it("TTL boundary: entry still seen at 10 minutes - 1ms", () => {
    const key = `acme/repo@ttl-boundary-${Date.now()}`;
    sourceShaDedup.mark(key);

    vi.advanceTimersByTime(10 * 60 * 1000 - 1);

    expect(sourceShaDedup.seen(key)).toBe(true);
  });

  it("LRU capacity: marking 5001 distinct keys evicts the oldest", () => {
    for (let i = 0; i < 5_001; i++) {
      sourceShaDedup.mark(`acme/repo@capacity-${i}`);
    }
    expect(sourceShaDedup.seen("acme/repo@capacity-0")).toBe(false);
    expect(sourceShaDedup.seen("acme/repo@capacity-5000")).toBe(true);
  });
});
