// In-tree semaphore replacing external `p-limit` to avoid supply-chain risk for a sole call-site.

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export default function pLimit(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`pLimit: concurrency must be a positive integer, got ${concurrency}`);
  }

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
