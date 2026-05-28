import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("loadEnv", () => {
  const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----";
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let savedEnv: NodeJS.ProcessEnv;
  let tmpDir: string;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    tmpDir = await mkdtemp(join(tmpdir(), "env-test-"));
    // Prevent actual process termination; capture calls for assertion
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function importLoadEnv() {
    const mod = await import("../../src/env.js");
    return mod.loadEnv;
  }

  function setValidInlineEnv(overrides: Record<string, string | undefined> = {}) {
    process.env = {
      ...savedEnv,
      APP_ID: "123",
      WEBHOOK_SECRET: "sixteen-chars-ok",
      PRIVATE_KEY: FAKE_PEM,
      PRIVATE_KEY_PATH: undefined,
      // Override NODE_ENV so Zod default applies regardless of vitest's NODE_ENV=test
      NODE_ENV: "production",
      ...overrides,
    };
  }

  it("returns Env with inline PRIVATE_KEY when valid", async () => {
    setValidInlineEnv();
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.APP_ID).toBe(123);
    expect(env.WEBHOOK_SECRET).toBe("sixteen-chars-ok");
    expect(env.PRIVATE_KEY).toBe(FAKE_PEM);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.WEBHOOK_QUEUE_MAX).toBe(1000);
    expect(env.SHUTDOWN_TIMEOUT).toBe(30000);
    expect(env.NODE_ENV).toBe("production");
  });

  it("reads PRIVATE_KEY from file when PRIVATE_KEY_PATH is given", async () => {
    const keyFile = join(tmpDir, "test.pem");
    await writeFile(keyFile, FAKE_PEM, "utf8");
    process.env = {
      ...savedEnv,
      APP_ID: "123",
      WEBHOOK_SECRET: "sixteen-chars-ok",
      PRIVATE_KEY: undefined,
      PRIVATE_KEY_PATH: keyFile,
    };
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.PRIVATE_KEY).toBe(FAKE_PEM);
  });

  it("exits with 1 when both PRIVATE_KEY and PRIVATE_KEY_PATH are set", async () => {
    const keyFile = join(tmpDir, "test.pem");
    await writeFile(keyFile, FAKE_PEM, "utf8");
    process.env = {
      ...savedEnv,
      APP_ID: "123",
      WEBHOOK_SECRET: "sixteen-chars-ok",
      PRIVATE_KEY: FAKE_PEM,
      PRIVATE_KEY_PATH: keyFile,
    };
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when neither PRIVATE_KEY nor PRIVATE_KEY_PATH is set", async () => {
    process.env = {
      ...savedEnv,
      APP_ID: "123",
      WEBHOOK_SECRET: "sixteen-chars-ok",
      PRIVATE_KEY: undefined,
      PRIVATE_KEY_PATH: undefined,
    };
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when APP_ID is missing", async () => {
    process.env = {
      ...savedEnv,
      WEBHOOK_SECRET: "sixteen-chars-ok",
      PRIVATE_KEY: FAKE_PEM,
      APP_ID: undefined,
    };
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when WEBHOOK_SECRET is shorter than 16 chars", async () => {
    setValidInlineEnv({ WEBHOOK_SECRET: "short" });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when SLACK_WEBHOOK_URL is not a valid URL", async () => {
    setValidInlineEnv({ SLACK_WEBHOOK_URL: "not-a-url" });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("applies defaults: PORT=3000, LOG_LEVEL=info, WEBHOOK_QUEUE_MAX=1000, SHUTDOWN_TIMEOUT=30000, NODE_ENV=production", async () => {
    setValidInlineEnv();
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.WEBHOOK_QUEUE_MAX).toBe(1000);
    expect(env.SHUTDOWN_TIMEOUT).toBe(30000);
    expect(env.NODE_ENV).toBe("production");
  });

  it("accepts valid SLACK_WEBHOOK_URL", async () => {
    setValidInlineEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/abc" });
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.SLACK_WEBHOOK_URL).toBe("https://hooks.slack.com/services/T000/B000/abc");
  });

  it("error output does not expose raw secret values in issue objects", async () => {
    setValidInlineEnv({ APP_ID: undefined });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    const errCall = errorSpy.mock.calls[0]?.[0] as string | undefined;
    if (errCall) {
      const parsed = JSON.parse(errCall) as { issues: Array<{ received?: unknown }> };
      for (const issue of parsed.issues) {
        expect(JSON.stringify(issue)).not.toContain(FAKE_PEM);
      }
    }
  });

  describe("Phase 3 env fields (D-23)", () => {
    it("applies defaults: WEBHOOK_QUEUE_PER_KEY_MAX=16, CRON_SCHEDULE='*/10 * * * *', CRON_TZ='UTC'", async () => {
      setValidInlineEnv();
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.WEBHOOK_QUEUE_PER_KEY_MAX).toBe(16);
      expect(env.CRON_SCHEDULE).toBe("*/10 * * * *");
      expect(env.CRON_TZ).toBe("UTC");
    });

    it("rejects WEBHOOK_QUEUE_PER_KEY_MAX=0 (must be positive)", async () => {
      setValidInlineEnv({ WEBHOOK_QUEUE_PER_KEY_MAX: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects WEBHOOK_QUEUE_PER_KEY_MAX=-1 (must be positive)", async () => {
      setValidInlineEnv({ WEBHOOK_QUEUE_PER_KEY_MAX: "-1" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects WEBHOOK_QUEUE_PER_KEY_MAX='abc' (non-numeric)", async () => {
      setValidInlineEnv({ WEBHOOK_QUEUE_PER_KEY_MAX: "abc" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts CRON_SCHEDULE='' (empty string disables cron, D-06)", async () => {
      setValidInlineEnv({ CRON_SCHEDULE: "" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.CRON_SCHEDULE).toBe("");
    });

    it("accepts custom WEBHOOK_QUEUE_PER_KEY_MAX", async () => {
      setValidInlineEnv({ WEBHOOK_QUEUE_PER_KEY_MAX: "32" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.WEBHOOK_QUEUE_PER_KEY_MAX).toBe(32);
    });

    it("accepts custom CRON_TZ", async () => {
      setValidInlineEnv({ CRON_TZ: "America/New_York" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.CRON_TZ).toBe("America/New_York");
    });
  });

  describe("Phase 4 notify env fields (D-22)", () => {
    it("applies defaults: NOTIFY_DEDUP_TTL_MS=3600000, NOTIFY_DEDUP_MAX=1000, NOTIFY_TIMEOUT_MS=5000, NOTIFY_RETRY_ATTEMPTS=3", async () => {
      setValidInlineEnv();
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.NOTIFY_DEDUP_TTL_MS).toBe(3_600_000);
      expect(env.NOTIFY_DEDUP_MAX).toBe(1000);
      expect(env.NOTIFY_TIMEOUT_MS).toBe(5000);
      expect(env.NOTIFY_RETRY_ATTEMPTS).toBe(3);
    });

    it("coerces NOTIFY_DEDUP_TTL_MS string to number", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_TTL_MS: "60000" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.NOTIFY_DEDUP_TTL_MS).toBe(60000);
    });

    it("rejects NOTIFY_DEDUP_TTL_MS=0 (must be positive)", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_TTL_MS: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects NOTIFY_DEDUP_TTL_MS=-1 (must be positive)", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_TTL_MS: "-1" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects NOTIFY_DEDUP_TTL_MS='abc' (non-numeric)", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_TTL_MS: "abc" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects NOTIFY_DEDUP_MAX=0 (must be positive)", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_MAX: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts custom NOTIFY_DEDUP_MAX", async () => {
      setValidInlineEnv({ NOTIFY_DEDUP_MAX: "500" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.NOTIFY_DEDUP_MAX).toBe(500);
    });

    it("rejects NOTIFY_TIMEOUT_MS=0 (must be positive)", async () => {
      setValidInlineEnv({ NOTIFY_TIMEOUT_MS: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts custom NOTIFY_TIMEOUT_MS", async () => {
      setValidInlineEnv({ NOTIFY_TIMEOUT_MS: "10000" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.NOTIFY_TIMEOUT_MS).toBe(10000);
    });

    it("rejects NOTIFY_RETRY_ATTEMPTS=0 (must be positive)", async () => {
      setValidInlineEnv({ NOTIFY_RETRY_ATTEMPTS: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts custom NOTIFY_RETRY_ATTEMPTS", async () => {
      setValidInlineEnv({ NOTIFY_RETRY_ATTEMPTS: "5" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.NOTIFY_RETRY_ATTEMPTS).toBe(5);
    });
  });

  describe("Phase 7 config default fallback env fields (D-04)", () => {
    it("applies default: DEFAULT_CONFIG_RELOAD_MS=60000", async () => {
      setValidInlineEnv();
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.DEFAULT_CONFIG_RELOAD_MS).toBe(60_000);
    });

    it("coerces DEFAULT_CONFIG_RELOAD_MS=15000 to number", async () => {
      setValidInlineEnv({ DEFAULT_CONFIG_RELOAD_MS: "15000" });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.DEFAULT_CONFIG_RELOAD_MS).toBe(15_000);
    });

    it("rejects DEFAULT_CONFIG_RELOAD_MS=0 (must be positive)", async () => {
      setValidInlineEnv({ DEFAULT_CONFIG_RELOAD_MS: "0" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects DEFAULT_CONFIG_RELOAD_MS='abc' (non-numeric)", async () => {
      setValidInlineEnv({ DEFAULT_CONFIG_RELOAD_MS: "abc" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("Phase 8 app-manifest setup env fields (D-01, D-11)", () => {
    it("applies defaults: SETUP_APP_NAME='auto-merge', SETUP_OUTPUT_DIR='./data'", async () => {
      setValidInlineEnv();
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.SETUP_APP_NAME).toBe("auto-merge");
      expect(env.SETUP_OUTPUT_DIR).toBe("./data");
    });

    it("accepts custom SETUP_APP_NAME and SETUP_OUTPUT_DIR overrides", async () => {
      setValidInlineEnv({
        SETUP_APP_NAME: "my-cascade-app",
        SETUP_OUTPUT_DIR: "/run/secrets",
      });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.SETUP_APP_NAME).toBe("my-cascade-app");
      expect(env.SETUP_OUTPUT_DIR).toBe("/run/secrets");
    });

    it("rejects SETUP_APP_NAME='' (min 1)", async () => {
      setValidInlineEnv({ SETUP_APP_NAME: "" });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("rejects SETUP_APP_NAME of length 35 (max 34)", async () => {
      setValidInlineEnv({ SETUP_APP_NAME: "a".repeat(35) });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts SETUP_APP_NAME of length 34", async () => {
      setValidInlineEnv({ SETUP_APP_NAME: "a".repeat(34) });
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.SETUP_APP_NAME).toBe("a".repeat(34));
    });

    it("regression: SETUP_ENABLED=true without SETUP_PUBLIC_URL still fails", async () => {
      setValidInlineEnv({ SETUP_ENABLED: "true", SETUP_PUBLIC_URL: undefined });
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("setup-only bootstrap mode", () => {
    it("returns _setupOnly=true when creds absent but SETUP_ENABLED+SETUP_PUBLIC_URL set", async () => {
      process.env = {
        ...savedEnv,
        APP_ID: undefined,
        WEBHOOK_SECRET: undefined,
        PRIVATE_KEY: undefined,
        PRIVATE_KEY_PATH: undefined,
        SETUP_ENABLED: "true",
        SETUP_PUBLIC_URL: "https://example.test",
        SETUP_OUTPUT_DIR: tmpDir,
      };
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env._setupOnly).toBe(true);
      expect(env.APP_ID).toBeUndefined();
      expect(env.WEBHOOK_SECRET).toBeUndefined();
      expect(env.PRIVATE_KEY).toBeUndefined();
    });

    it("loads credentials from SETUP_OUTPUT_DIR/credentials.env when env vars absent", async () => {
      const credBody = [
        `APP_ID=42`,
        `WEBHOOK_SECRET=loaded-from-file-secret`,
        `PRIVATE_KEY="${FAKE_PEM}"`,
        "",
      ].join("\n");
      await writeFile(join(tmpDir, "credentials.env"), credBody, "utf8");

      process.env = {
        ...savedEnv,
        APP_ID: undefined,
        WEBHOOK_SECRET: undefined,
        PRIVATE_KEY: undefined,
        PRIVATE_KEY_PATH: undefined,
        SETUP_ENABLED: "true",
        SETUP_PUBLIC_URL: "https://example.test",
        SETUP_OUTPUT_DIR: tmpDir,
      };
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env._setupOnly).toBe(false);
      expect(env.APP_ID).toBe(42);
      expect(env.WEBHOOK_SECRET).toBe("loaded-from-file-secret");
      expect(env.PRIVATE_KEY).toBe(FAKE_PEM);
    });

    it("process.env wins over credentials.env on overlapping keys", async () => {
      const credBody = [
        `APP_ID=42`,
        `WEBHOOK_SECRET=from-file`,
        `PRIVATE_KEY="${FAKE_PEM}"`,
        "",
      ].join("\n");
      await writeFile(join(tmpDir, "credentials.env"), credBody, "utf8");

      process.env = {
        ...savedEnv,
        APP_ID: "999",
        WEBHOOK_SECRET: "from-env-sixteen",
        PRIVATE_KEY: FAKE_PEM,
        PRIVATE_KEY_PATH: undefined,
        SETUP_OUTPUT_DIR: tmpDir,
      };
      const loadEnv = await importLoadEnv();
      const env = loadEnv();
      expect(env.APP_ID).toBe(999);
      expect(env.WEBHOOK_SECRET).toBe("from-env-sixteen");
    });

    it("exits when no creds in env, no credentials.env file, no SETUP_ENABLED", async () => {
      process.env = {
        ...savedEnv,
        APP_ID: undefined,
        WEBHOOK_SECRET: undefined,
        PRIVATE_KEY: undefined,
        PRIVATE_KEY_PATH: undefined,
        SETUP_ENABLED: undefined,
        SETUP_OUTPUT_DIR: tmpDir,
      };
      const loadEnv = await importLoadEnv();
      expect(() => loadEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
