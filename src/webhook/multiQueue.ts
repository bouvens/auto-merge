import { log } from "../log.js";
import type { NotificationChannel } from "../notify/channel.js";
import type { Handler, Job } from "./queue.js";

export type { Job, Handler };

export interface MultiQueue<T> {
  enqueue(key: string, job: Job<T>): void;
  drain(timeoutMs: number): Promise<void>;
  size(): number;
  keyCount(): number;
}

interface Lane<T> {
  buf: Job<T>[];
  running: boolean;
}

interface DrainCall {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MultiQueueOpts<T> {
  perKeyMax: number;
  globalMax: number;
  handler: Handler<T>;
  notify: NotificationChannel;
}

export function createMultiQueue<T>(opts: MultiQueueOpts<T>): MultiQueue<T> {
  const lanes = new Map<string, Lane<T>>();
  const drainCalls: DrainCall[] = [];

  const runLane = async (key: string): Promise<void> => {
    const lane = lanes.get(key);
    if (!lane || lane.running) return;
    lane.running = true;
    while (lane.buf.length > 0) {
      const job = lane.buf.shift() as Job<T>;
      try {
        await opts.handler(job);
      } catch (err) {
        log.error({ err, key, delivery_id: job.id }, "worker-handler-failed");
      }
    }
    lane.running = false;
    // Map.delete() and the subsequent size check are in the same sync tick — no enqueue can interleave because Node is single-threaded and there is no async suspension between these statements.
    if (lane.buf.length === 0) lanes.delete(key);
    if (lanes.size === 0) {
      for (const call of drainCalls.splice(0)) {
        clearTimeout(call.timer);
        call.resolve();
      }
    }
  };

  const size = (): number => {
    let total = 0;
    for (const lane of lanes.values()) total += lane.buf.length;
    return total;
  };

  const dropOverflow = (targetKey: string, targetLane: Lane<T>, queueMax: number): void => {
    const dropped = targetLane.buf.shift() as Job<T>;
    log.warn(
      { event: "multi_queue_overflow", key: targetKey, dropped_id: dropped.id, queue_max: queueMax },
      "drop-oldest",
    );
    // Fire-and-forget; catch prevents a rejecting notify from crashing the synchronous enqueue path.
    opts.notify.notify({ kind: "queue_overflow", key: targetKey, dropped_id: dropped.id }).catch(
      (err: unknown) => log.error({ err, event: "notify_failed" }, "notify"),
    );
  };

  return {
    enqueue(key, job) {
      let lane = lanes.get(key);
      if (!lane) {
        lane = { buf: [], running: false };
        lanes.set(key, lane);
      }

      const total = size();
      if (total >= opts.globalMax) {
        // Global cap: drop from the largest lane to defend against fan-out across many repos (D-02).
        let maxLen = 0;
        let maxKey = key;
        let maxLane = lane;
        for (const [k, l] of lanes) {
          if (l.buf.length > maxLen) {
            maxLen = l.buf.length;
            maxKey = k;
            maxLane = l;
          }
        }
        dropOverflow(maxKey, maxLane, opts.globalMax);
      } else if (lane.buf.length >= opts.perKeyMax) {
        dropOverflow(key, lane, opts.perKeyMax);
      }

      lane.buf.push(job);
      // Defer worker start so all synchronous enqueues apply overflow policy before the first dequeue.
      void Promise.resolve().then(() => runLane(key));
    },

    drain(timeoutMs) {
      if (lanes.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        // Each concurrent drain() call gets its own timer so a short-timeout call does not cancel the timer of a concurrent long-timeout call.
        const timer = setTimeout(() => {
          const idx = drainCalls.findIndex((c) => c.timer === timer);
          if (idx !== -1) drainCalls.splice(idx, 1);
          log.warn(
            {
              event: "multi_queue_drain_timeout",
              remaining_keys: [...lanes.keys()],
              remaining_total: size(),
              timeout_ms: timeoutMs,
            },
            "drain-timeout",
          );
          resolve();
        }, timeoutMs);
        drainCalls.push({ resolve, timer });
      });
    },

    size,

    keyCount() {
      return lanes.size;
    },
  };
}

/**
 * Build the per-repo queue key. Keyed to repo not branch because the cascade is per-repo (D-01).
 */
export function buildKey(job: { installation_id: number; owner: string; repo: string }): string {
  return `${job.installation_id}/${job.owner}/${job.repo}`;
}
