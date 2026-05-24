import { log } from "../log.js";
import type { NotificationChannel, NotifyEvent } from "./channel.js";

export interface MultiChannelOptions {
  // Returns true when notifications for `installationId` should be silently dropped (onboarding window).
  suppressionCheck?: (installationId: number) => boolean;
}

export class MultiChannel implements NotificationChannel {
  constructor(
    private readonly channels: NotificationChannel[],
    private readonly options: MultiChannelOptions = {},
  ) {}

  async notify(event: NotifyEvent): Promise<void> {
    // D-21: cascade-conflict / queue_overflow during onboarding is expected noise — gate uniformly here so individual channels don't need awareness
    const instId = extractInstallationId(event);
    if (instId !== undefined && this.options.suppressionCheck?.(instId) === true) {
      log.debug(
        { event: "notify_suppressed_onboarding", kind: event.kind, installation_id: instId },
        "notify",
      );
      return;
    }
    // Each channel dead-letters internally; never propagate rejections to the orchestrator.
    await Promise.allSettled(this.channels.map((c) => c.notify(event)));
  }
}

// queue_overflow has no installation_id field; key format is `${installation_id}/${owner}/${repo}` per buildKey.
function extractInstallationId(event: NotifyEvent): number | undefined {
  if ("installation_id" in event && typeof event.installation_id === "number") {
    return event.installation_id;
  }
  if (event.kind === "queue_overflow") {
    const prefix = event.key.split("/")[0];
    if (prefix === undefined) return undefined;
    const id = Number.parseInt(prefix, 10);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}
