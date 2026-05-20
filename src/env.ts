import { readFileSync } from "node:fs";
import { z } from "zod";

const Base = z.object({
  APP_ID: z.coerce.number().int().positive(),
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET must be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  WEBHOOK_QUEUE_MAX: z.coerce.number().int().positive().default(1000),
  SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30000),
  SLACK_WEBHOOK_URL: z.url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});

// z.xor enforces exactly one variant — before Zod 4 this required superRefine.
const KeyXor = z.xor([
  z.object({ PRIVATE_KEY: z.string().min(1), PRIVATE_KEY_PATH: z.undefined() }),
  z.object({ PRIVATE_KEY: z.undefined(), PRIVATE_KEY_PATH: z.string().min(1) }),
]);

const EnvSchema = Base.and(KeyXor);

// PRIVATE_KEY is always a resolved string after loadEnv, regardless of which source was used.
export type Env = Omit<z.infer<typeof EnvSchema>, "PRIVATE_KEY" | "PRIVATE_KEY_PATH"> & {
  PRIVATE_KEY: string;
};

export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    // console.error here because pino is not yet initialised at boot time.
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

  // Synchronous file read is acceptable at boot-time before the event loop opens (D-23).
  const keyPath = e.PRIVATE_KEY_PATH;
  const PRIVATE_KEY = e.PRIVATE_KEY ?? (keyPath !== undefined ? readFileSync(keyPath, "utf8") : "");

  const { PRIVATE_KEY: _inlineKey, PRIVATE_KEY_PATH: _path, ...rest } = e;
  return { ...rest, PRIVATE_KEY };
}
