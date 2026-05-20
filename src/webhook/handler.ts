import type { Probot } from "probot";
import { log } from "../log.js";

// Lifecycle events are handled here (log only), separate from the cascade enqueue path to avoid non-cascade events polluting the worker queue.
export function registerHandlers(probot: Probot): void {
  for (const ev of [
    "installation",
    "installation_repositories",
    "installation_target",
    "ping",
  ] as const) {
    probot.on(ev, async (ctx) => {
      log.info(
        {
          event: ev,
          action: (ctx.payload as { action?: string }).action,
          installation_id: (ctx.payload as { installation?: { id: number } }).installation?.id,
          delivery_id: ctx.id,
        },
        "lifecycle",
      );
    });
  }
}
