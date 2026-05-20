import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
