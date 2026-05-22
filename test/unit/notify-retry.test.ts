import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, withRetry } from "../../src/notify/retry.js";
import type { RetryOpts } from "../../src/notify/retry.js";

const defaultOpts: RetryOpts = {
  attempts: 3,
  baseDelayMs: 10, // small value so fake-timer advance stays fast
  jitterMs: 0, // zero jitter for deterministic tests
  maxRetryAfterMs: 30_000,
};

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns value on first successful attempt without any sleep", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, defaultOpts);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 3 times on 5xx and then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500, "server error"));
    const promise = withRetry(fn, defaultOpts);
    // Advance past all backoff delays (10ms + 20ms = 30ms total with jitterMs=0)
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("breaks immediately on 4xx — only 1 attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(400, "bad request"));
    // Await rejection directly before running timers — 4xx should not sleep at all
    await expect(withRetry(fn, defaultOpts)).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("breaks immediately on 403 — only 1 attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(403, "forbidden"));
    await expect(withRetry(fn, defaultOpts)).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and uses retryAfterMs from HttpError, capped at maxRetryAfterMs", async () => {
    const retryAfterMs = 50;
    const fn = vi.fn().mockRejectedValue(new HttpError(429, "rate limited", retryAfterMs));
    const promise = withRetry(fn, { ...defaultOpts, attempts: 2, maxRetryAfterMs: 200 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("caps Retry-After at maxRetryAfterMs when provider sends large value", async () => {
    const largeRetryAfterMs = 60_000; // > maxRetryAfterMs
    const fn = vi.fn().mockRejectedValue(new HttpError(429, "rate limited", largeRetryAfterMs));
    // Use a small maxRetryAfterMs so fake-timer advance stays fast
    const promise = withRetry(fn, { ...defaultOpts, attempts: 2, maxRetryAfterMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on TimeoutError (AbortSignal.timeout fires)", async () => {
    const timeoutErr = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const fn = vi.fn().mockRejectedValue(timeoutErr);
    const promise = withRetry(fn, defaultOpts);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on AbortError (undici streaming quirk)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fn = vi.fn().mockRejectedValue(abortErr);
    const promise = withRetry(fn, defaultOpts);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on TypeError (fetch ECONNREFUSED wrapped as TypeError)", async () => {
    const typeErr = new TypeError("fetch failed");
    const fn = vi.fn().mockRejectedValue(typeErr);
    const promise = withRetry(fn, defaultOpts);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds on second attempt after transient 5xx", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, "unavailable"))
      .mockResolvedValue("recovered");
    const promise = withRetry(fn, defaultOpts);
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("HttpError", () => {
  it("sets status, bodyText and name", () => {
    const err = new HttpError(500, "internal server error");
    expect(err.status).toBe(500);
    expect(err.bodyText).toBe("internal server error");
    expect(err.name).toBe("HttpError");
    expect(err).toBeInstanceOf(Error);
  });

  it("sets optional retryAfterMs", () => {
    const err = new HttpError(429, "rate limited", 2000);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("message includes status and body", () => {
    const err = new HttpError(403, "forbidden");
    expect(err.message).toContain("403");
    expect(err.message).toContain("forbidden");
  });
});
