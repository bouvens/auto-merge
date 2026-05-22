export class HttpError extends Error {
  constructor(
    public status: number,
    public bodyText: string,
    public retryAfterMs?: number,
  ) {
    super(`http ${status}: ${bodyText}`);
    this.name = "HttpError";
  }
}

export interface RetryOpts {
  attempts: number;
  baseDelayMs: number;
  jitterMs: number;
  maxRetryAfterMs: number;
}

// Object-map for error name → retryable decision (CLAUDE.md: prefer objects for mappings).
const RETRYABLE_ERROR_NAMES: Record<string, true> = {
  TimeoutError: true,
  // AbortError covers undici streaming quirk: AbortSignal.timeout fires during body read.
  AbortError: true,
  // TypeError covers ECONNREFUSED / DNS fail that Node wraps as TypeError with message "fetch failed".
  TypeError: true,
};

function isRetryable(err: unknown): boolean {
  if (err instanceof Error && RETRYABLE_ERROR_NAMES[err.name]) return true;
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts) break;
      if (!isRetryable(err)) break;
      const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * opts.jitterMs * 2) - opts.jitterMs;
      const delayMs = retryAfterMs
        ? Math.min(retryAfterMs, opts.maxRetryAfterMs)
        : Math.min(backoff + jitter, opts.maxRetryAfterMs);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
