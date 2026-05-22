import { log } from "../log.js";

export type NotifyEvent =
  | { kind: "queue_overflow"; key: string; dropped_id: string }
  | { kind: "cascade_conflict"; run_id: string; repo: string; src: string; tgt: string; pr_url: string; author_login?: string; installation_id?: number }
  | { kind: "protection_blocked"; run_id: string; repo: string; src: string; tgt: string; pr_url: string; rule: string; author_login?: string; installation_id?: number }
  | { kind: "permission_error"; run_id: string; repo: string; src: string; tgt: string; endpoint: string; status: number; missing_permission: string; installation_id?: number }
  | { kind: "config_invalid"; repo: string; config_path: string; zod_error: string; installation_id?: number };

export interface NotificationChannel {
  notify(event: NotifyEvent): Promise<void>;
}

// No-op default until real notification channels are wired.
export class NoopChannel implements NotificationChannel {
  async notify(event: NotifyEvent): Promise<void> {
    log.info({ event: `notify_${event.kind}`, payload: event }, "notify");
  }
}
