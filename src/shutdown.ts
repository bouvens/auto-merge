import type { FastifyInstance } from "fastify";
import type pino from "pino";
import type { MultiQueue } from "./webhook/multiQueue.js";

export interface ShutdownDeps {
  app: FastifyInstance | undefined;
  cronHandle: { stop: () => Promise<void> } | undefined;
  multiQueue: MultiQueue<unknown> | undefined;
  // sync clearInterval (no in-flight work to drain)
  defaultLoaderStop: () => void;
  log: pino.Logger;
  shutdownTimeoutMs: number;
}

// Lets the catch block distinguish a test-stub exit throw from a real error.
const EXIT_THROW_MARKER = "__process_exit_throw__";

function isExitThrow(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as Error & { [EXIT_THROW_MARKER]?: true })[EXIT_THROW_MARKER] === true
  );
}

/**
 * Builds the shutdown function with injected dependencies so integration tests
 * can wire in spies without booting the full application.
 */
export function makeShutdown(deps: ShutdownDeps): (sig: string) => Promise<void> {
  let shuttingDown = false;
  return async (sig: string) => {
    if (shuttingDown) {
      deps.log.warn({ sig, event: "shutdown_already_in_progress" }, "shutdown");
      return;
    }
    shuttingDown = true;
    deps.log.info({ sig, event: "shutdown_start" }, "shutdown");
    try {
      // D-18: stop cron first so no new jobs enter the queue while we drain.
      if (deps.cronHandle) await deps.cronHandle.stop();
      // Clear the defaultLoader interval before app.close — sync, never throws (per defaultLoader.stop contract).
      deps.defaultLoaderStop();
      await deps.app?.close();
      // Drain timeout exits 0 per D-19 (timeout is not an error).
      if (deps.multiQueue) await deps.multiQueue.drain(deps.shutdownTimeoutMs);
      deps.log.info({ event: "shutdown_clean" }, "shutdown");
      process.exit(0);
    } catch (e) {
      if (isExitThrow(e)) throw e;
      deps.log.error({ err: e, event: "shutdown_error" }, "shutdown");
      process.exit(1);
    }
  };
}

/**
 * Creates a process.exit stub for tests that throws a marked error rather than
 * terminating the process. The marker lets makeShutdown's catch re-throw rather
 * than call process.exit(1) over the original code.
 */
export function makeExitStub(): (code: number) => never {
  return (code: number): never => {
    const err = Object.assign(new Error(`exit:${code}`), {
      [EXIT_THROW_MARKER]: true as const,
    });
    throw err;
  };
}
