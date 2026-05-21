import pino from "pino";
import type { Env } from "./env.js";

// Each secret field needs both root-level and wildcard paths: pino *.x only matches nested, not top-level.
const REDACT_PATHS = [
  "privateKey",
  "*.privateKey",
  "private_key",
  "*.private_key",
  "PRIVATE_KEY",
  "*.PRIVATE_KEY",
  "token",
  "*.token",
  "bot_token",
  "*.bot_token",
  "botToken",
  "*.botToken",
  "webhook_url",
  "*.webhook_url",
  "webhookUrl",
  "*.webhookUrl",
  'headers["x-hub-signature-256"]',
  "headers.authorization",
  "payload",
  "*.payload",
  "err.event.payload",
  "event.payload",
];

export type LogDestination = { write: (chunk: string) => void };

export function initLogger(
  env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">,
  destination?: LogDestination,
): pino.Logger {
  const opts: pino.LoggerOptions = {
    level: env.LOG_LEVEL,
    // remove:false keeps [REDACTED] in output so log consumers know the field exists.
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]", remove: false },
    // No transport in prod — raw JSON stdout works with any log aggregator (D-20).
    transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
  };

  return destination ? pino(opts, destination) : pino(opts);
}

// Singleton created at import time; by then env.ts has already exited on invalid env.
export const log = initLogger({
  LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as Env["LOG_LEVEL"],
  NODE_ENV: (process.env.NODE_ENV ?? "production") as Env["NODE_ENV"],
});
