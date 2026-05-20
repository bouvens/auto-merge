import { log } from "../log.js";

export interface Job<T = unknown> {
  id: string;
  payload: T;
}

export type Handler<T> = (job: Job<T>) => Promise<void>;

// Stable interface contracts allow swapping the internal dispatch strategy without modifying callers.
export interface Queue<T> {
  enqueue(job: Job<T>): void;
  drain(timeoutMs: number): Promise<void>;
  size(): number;
}

export function createQueue<T>(opts: { max: number; handler: Handler<T> }): Queue<T> {
  const buf: Job<T>[] = [];
  let running = false;
  const drainResolvers: Array<() => void> = [];

  const runLoop = async () => {
    if (running) return;
    running = true;
    while (buf.length > 0) {
      const job = buf.shift() as Job<T>;
      try {
        await opts.handler(job);
      } catch (err) {
        log.error({ err, delivery_id: job.id }, "worker-handler-failed");
      }
    }
    running = false;
    for (const resolve of drainResolvers.splice(0)) resolve();
  };

  return {
    enqueue(job) {
      if (buf.length >= opts.max) {
        const dropped = buf.shift() as Job<T>;
        log.warn(
          { event: "queue_overflow", dropped_delivery_id: dropped.id, queue_max: opts.max },
          "drop-oldest",
        );
      }
      buf.push(job);
      // Defer worker start so all synchronous enqueues apply overflow policy before the first dequeue.
      void Promise.resolve().then(() => runLoop());
    },

    drain(timeoutMs) {
      if (buf.length === 0 && !running) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          log.warn({ remaining: buf.length, timeout_ms: timeoutMs }, "drain-timeout");
          resolve();
        }, timeoutMs);
        drainResolvers.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },

    size() {
      return buf.length;
    },
  };
}
