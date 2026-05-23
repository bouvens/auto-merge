import { readFileSync, statSync } from "node:fs";
import type pino from "pino";
import { type ConfigSource, parseConfig } from "./loader.js";
import type { Config } from "./schema.js";

// Subset of ConfigSource — only fallback sources; "repo" is owned by loader.ts (D-08).
type DefaultSource = Exclude<ConfigSource, "repo">;

export interface DefaultLoader {
  get(): { config: Config; source: DefaultSource } | undefined;
  stop(): void;
}

interface DefaultLoaderEnv {
  DEFAULT_CASCADE_CONFIG_FILE?: string;
  DEFAULT_CASCADE_CONFIG_YAML?: string;
  DEFAULT_CONFIG_RELOAD_MS: number;
}

export function createDefaultConfigLoader(
  env: DefaultLoaderEnv,
  log: pino.Logger,
  exit: (code: number) => never = process.exit as (code: number) => never,
): DefaultLoader {
  let current: { config: Config; source: DefaultSource } | undefined;
  let lastMtime = -1;
  let intervalHandle: NodeJS.Timeout | undefined;

  const filePath = env.DEFAULT_CASCADE_CONFIG_FILE;
  const yamlInline = env.DEFAULT_CASCADE_CONFIG_YAML;

  // D-02: FILE takes precedence; YAML is ignored with a one-time warn.
  if (filePath && yamlInline) {
    log.warn(
      { event: "default_config_yaml_ignored" },
      "DEFAULT_CASCADE_CONFIG_YAML ignored: DEFAULT_CASCADE_CONFIG_FILE takes precedence",
    );
  }

  if (filePath) {
    let stat: ReturnType<typeof statSync>;
    let text: string;
    try {
      stat = statSync(filePath);
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      // D-03: ENOENT (or any read failure) at boot is a deploy bug, not a degraded state.
      log.fatal(
        { event: "default_config_file_missing_at_boot", path: filePath, err: String(err) },
        "default-config",
      );
      exit(1);
    }

    const parsed = parseConfig(text);
    if (parsed.errors.length > 0) {
      // D-01: invalid YAML at boot — fail-fast symmetric with env.ts.
      log.fatal(
        { event: "default_config_invalid", source: "file", path: filePath, errors: parsed.errors },
        "default-config",
      );
      exit(1);
    }

    current = { config: parsed.config as Config, source: "file_default" };
    lastMtime = stat.mtimeMs;
    log.info(
      { event: "default_config_loaded", source: "file_default", path: filePath },
      "default-config",
    );

    // sync I/O by design — overlap-free at 60s cadence; parseConfig is pure (R-3)
    const tick = (): void => {
      try {
        const s = statSync(filePath);
        if (s.mtimeMs === lastMtime) return;
        const t = readFileSync(filePath, "utf8");
        const p = parseConfig(t);
        if (p.errors.length > 0) {
          // D-06: keep last-known-good; do not update lastMtime so next tick retries.
          log.error(
            { event: "default_config_reload_failed", path: filePath, errors: p.errors },
            "default-config",
          );
          return;
        }
        current = { config: p.config as Config, source: "file_default" };
        lastMtime = s.mtimeMs;
        log.info(
          { event: "default_config_reloaded", path: filePath, mtime: s.mtimeMs },
          "default-config",
        );
      } catch (err) {
        // D-07: transient ENOENT during ConfigMap remount — keep last-known-good.
        log.error(
          { event: "default_config_file_missing", path: filePath, err: String(err) },
          "default-config",
        );
      }
    };

    intervalHandle = setInterval(tick, env.DEFAULT_CONFIG_RELOAD_MS);
    intervalHandle.unref();
  } else if (yamlInline) {
    const parsed = parseConfig(yamlInline);
    if (parsed.errors.length > 0) {
      log.fatal(
        { event: "default_config_invalid", source: "env", errors: parsed.errors },
        "default-config",
      );
      exit(1);
    }
    current = { config: parsed.config as Config, source: "env_default" };
    // D-05: YAML inline is restart-only — no interval started.
    log.info({ event: "default_config_loaded", source: "env_default" }, "default-config");
  }

  return {
    get: () => current,
    stop: () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
    },
  };
}

// Module singleton trio wires the factory into a process-wide instance for index.ts boot / shutdown.ts teardown / loader.ts fallback consumer.
let instance: DefaultLoader | undefined;

export function initDefaultConfigLoader(
  env: DefaultLoaderEnv,
  log: pino.Logger,
  exit?: (code: number) => never,
): DefaultLoader {
  instance = createDefaultConfigLoader(env, log, exit);
  return instance;
}

export function getDefaultConfig(): { config: Config; source: DefaultSource } | undefined {
  return instance?.get();
}

export function stopDefaultConfigLoader(): void {
  instance?.stop();
  instance = undefined;
}
