import type { Probot } from "probot";
import { log } from "../log.js";
import type { OnboardingHandlers } from "../onboarding/handler.js";

// Lifecycle events are handled here (log only), separate from the cascade enqueue path to avoid non-cascade events polluting the worker queue.
export function registerHandlers(probot: Probot, deps: { onboarding: OnboardingHandlers }): void {
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

  // D-01 / D-02: action-scoped subscribers delegate to onboarding domain. Parent-event lifecycle log above continues to capture all actions (created/deleted/suspend/unsuspend/...) for audit.
  probot.on("installation.created", async (ctx) => {
    await deps.onboarding.onInstallation(ctx);
  });
  probot.on("installation_repositories.added", async (ctx) => {
    await deps.onboarding.onRepositoriesAdded(ctx);
  });
  probot.on("installation.deleted", async (ctx) => {
    await deps.onboarding.onInstallationDeleted(ctx);
  });
}
