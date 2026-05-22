import type { NotificationChannel, NotifyEvent } from "./channel.js";

export class MultiChannel implements NotificationChannel {
  constructor(private readonly channels: NotificationChannel[]) {}

  async notify(event: NotifyEvent): Promise<void> {
    // Each channel dead-letters internally; never propagate rejections to the orchestrator.
    await Promise.allSettled(this.channels.map((c) => c.notify(event)));
  }
}
