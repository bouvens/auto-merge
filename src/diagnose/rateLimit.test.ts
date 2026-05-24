import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnoseRateLimit } from "./rateLimit.js";

describe("createDiagnoseRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first 10 calls per ip", () => {
    const rl = createDiagnoseRateLimit();
    for (let i = 0; i < 10; i++) {
      expect(rl.check("1.2.3.4")).toEqual({ allowed: true });
    }
  });

  it("denies 11th call within window with retryAfterSec in [1..60]", () => {
    const rl = createDiagnoseRateLimit();
    for (let i = 0; i < 10; i++) rl.check("1.2.3.4");
    const result = rl.check("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("resets counter after advancing past the window", () => {
    const rl = createDiagnoseRateLimit();
    for (let i = 0; i < 10; i++) rl.check("1.2.3.4");
    expect(rl.check("1.2.3.4").allowed).toBe(false);
    // Advance just past the 60s window.
    vi.advanceTimersByTime(60_001);
    expect(rl.check("1.2.3.4")).toEqual({ allowed: true });
  });

  it("isolates budgets per ip", () => {
    const rl = createDiagnoseRateLimit();
    for (let i = 0; i < 10; i++) rl.check("1.1.1.1");
    expect(rl.check("1.1.1.1").allowed).toBe(false);
    // Different ip starts with a fresh 10-budget.
    for (let i = 0; i < 10; i++) {
      expect(rl.check("2.2.2.2")).toEqual({ allowed: true });
    }
  });

  it("rounds retryAfterSec up via Math.ceil (sub-second remainder → 1)", () => {
    const rl = createDiagnoseRateLimit();
    for (let i = 0; i < 10; i++) rl.check("9.9.9.9");
    // 59.6s into window — 0.4s remaining → ceil(0.4) = 1.
    vi.advanceTimersByTime(59_600);
    const result = rl.check("9.9.9.9");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBe(1);
  });
});
