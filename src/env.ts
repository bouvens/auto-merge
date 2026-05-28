import { readFileSync } from "node:fs";
import { z } from "zod";
import { readCredentialsFile } from "./setup/credentials.js";

const Base = z.object({
  APP_ID: z.coerce.number().int().positive().optional(),
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET must be at least 16 characters").optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  WEBHOOK_QUEUE_MAX: z.coerce.number().int().positive().default(1000),
  SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30000),
  WEBHOOK_QUEUE_PER_KEY_MAX: z.coerce.number().int().positive().default(16),
  // Empty string disables cron; syntax is validated by croner at construction time.
  CRON_SCHEDULE: z.string().default("*/10 * * * *"),
  CRON_TZ: z.string().default("UTC"),
  SLACK_WEBHOOK_URL: z.url().optional(),
  // min(40) catches truncated/empty tokens without locking to provider-specific regex.
  TELEGRAM_BOT_TOKEN: z.string().min(40).optional(),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().min(1).optional(),
  NOTIFY_HEALTHCHECK_REQUIRED: z.coerce.boolean().default(false),
  NOTIFY_HEALTHCHECK_TTL_MS: z.coerce.number().int().positive().default(900_000),
  SETUP_ENABLED: z.coerce.boolean().default(false),
  SETUP_PUBLIC_URL: z.url().optional(),
  SETUP_APP_NAME: z.string().min(1).max(34).default("auto-merge"),
  SETUP_OUTPUT_DIR: z.string().default("./data"),
  DEFAULT_CASCADE_CONFIG_FILE: z.string().optional(),
  DEFAULT_CASCADE_CONFIG_YAML: z.string().optional(),
  DEFAULT_CONFIG_RELOAD_MS: z.coerce.number().int().positive().default(60_000),
  DIAGNOSE_TOKEN: z.string().min(16).optional(),
  NOTIFY_DEDUP_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  NOTIFY_DEDUP_MAX: z.coerce.number().int().positive().default(1000),
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NOTIFY_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});

const KeyFields = z.object({
  PRIVATE_KEY: z.string().min(1).optional(),
  PRIVATE_KEY_PATH: z.string().min(1).optional(),
});

const EnvSchema = Base.extend(KeyFields.shape)
  .refine((e) => !(e.PRIVATE_KEY && e.PRIVATE_KEY_PATH), {
    message: "PRIVATE_KEY and PRIVATE_KEY_PATH are mutually exclusive",
    path: ["PRIVATE_KEY"],
  })
  .superRefine((e, ctx) => {
    if (e.SETUP_ENABLED && !e.SETUP_PUBLIC_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["SETUP_PUBLIC_URL"],
        message: "SETUP_PUBLIC_URL is required when SETUP_ENABLED=true",
      });
    }
    const hasCreds =
      e.APP_ID != null && e.WEBHOOK_SECRET != null && (e.PRIVATE_KEY || e.PRIVATE_KEY_PATH);
    const setupReady = e.SETUP_ENABLED && e.SETUP_PUBLIC_URL;
    if (!hasCreds && !setupReady) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ID"],
        message:
          "Provide APP_ID + WEBHOOK_SECRET + PRIVATE_KEY (or PRIVATE_KEY_PATH), OR enable SETUP_ENABLED=true with SETUP_PUBLIC_URL to self-bootstrap.",
      });
    }
  });

type BaseEnv = Omit<
  z.infer<typeof EnvSchema>,
  "PRIVATE_KEY" | "PRIVATE_KEY_PATH" | "APP_ID" | "WEBHOOK_SECRET"
>;

// _setupOnly narrows credential presence: full mode guarantees creds; setup-only mode has none yet.
export type FullEnv = BaseEnv & {
  _setupOnly: false;
  APP_ID: number;
  WEBHOOK_SECRET: string;
  PRIVATE_KEY: string;
};

export type SetupOnlyEnv = BaseEnv & {
  _setupOnly: true;
  APP_ID?: undefined;
  WEBHOOK_SECRET?: undefined;
  PRIVATE_KEY?: undefined;
};

export type Env = FullEnv | SetupOnlyEnv;

// PaaS env vars and k8s Secrets without stringData deliver base64-encoded PEM.
export function decodeMaybeBase64Pem(raw: string): string {
  if (raw.includes("-----BEGIN")) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  return raw;
}

export function loadEnv(): Env {
  // Layer order: process.env > credentials.env on disk. File survives pod restart after /setup/new completes.
  const setupDir = process.env.SETUP_OUTPUT_DIR ?? "./data";
  const fileCreds = readCredentialsFile(setupDir);

  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ID: process.env.APP_ID ?? fileCreds.id?.toString(),
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? fileCreds.webhook_secret,
    PRIVATE_KEY: process.env.PRIVATE_KEY ?? fileCreds.pem,
  };

  const result = EnvSchema.safeParse(merged);

  if (!result.success) {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "env-invalid",
        issues: result.error.issues,
      }),
    );
    process.exit(1);
  }

  const e = result.data;
  const { PRIVATE_KEY: _inlineKey, PRIVATE_KEY_PATH: _path, APP_ID, WEBHOOK_SECRET, ...rest } = e;

  if (APP_ID != null && WEBHOOK_SECRET != null && (e.PRIVATE_KEY || e.PRIVATE_KEY_PATH)) {
    // Sync read acceptable at boot before event loop opens.
    const rawKey =
      e.PRIVATE_KEY ??
      (e.PRIVATE_KEY_PATH !== undefined ? readFileSync(e.PRIVATE_KEY_PATH, "utf8") : "");
    const PRIVATE_KEY = decodeMaybeBase64Pem(rawKey);
    return { ...rest, _setupOnly: false, APP_ID, WEBHOOK_SECRET, PRIVATE_KEY };
  }

  return { ...rest, _setupOnly: true };
}
