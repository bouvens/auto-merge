import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _reset, isOnboarding, markOnboarding } from "../../src/onboarding/suppressionSet.js";

describe("onboarding/suppressionSet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    _reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true immediately after markOnboarding for the same id", () => {
    markOnboarding(123);
    expect(isOnboarding(123)).toBe(true);
  });

  it("returns false for an installation id that was never marked", () => {
    expect(isOnboarding(999)).toBe(false);
  });

  it("returns false after TTL has elapsed (lazy purge removes entry)", () => {
    markOnboarding(123);
    vi.advanceTimersByTime(600_001);
    expect(isOnboarding(123)).toBe(false);
    // Subsequent reads still false — the expired entry was deleted on the previous read.
    expect(isOnboarding(123)).toBe(false);
  });

  it("re-marking the same id extends TTL to the second call's expiry", () => {
    markOnboarding(123);
    vi.advanceTimersByTime(9 * 60 * 1000); // t = 9min, original window still alive
    markOnboarding(123); // new expiry at t = 19min
    vi.advanceTimersByTime(9 * 60 * 1000); // t = 18min — original would have expired, second window alive
    expect(isOnboarding(123)).toBe(true);
  });

  it("_reset() clears the map so previously marked ids return false", () => {
    markOnboarding(123);
    markOnboarding(456);
    _reset();
    expect(isOnboarding(123)).toBe(false);
    expect(isOnboarding(456)).toBe(false);
  });
});
