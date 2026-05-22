import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("loadEnv v1.1 env vars", () => {
  const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----";
  const VALID_TG_TOKEN = `${"0".repeat(10)}:${"a".repeat(35)}`;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function importLoadEnv() {
    const mod = await import("../../src/env.js");
    return mod.loadEnv;
  }

  function setBaseEnv(overrides: Record<string, string | undefined> = {}) {
    process.env = {
      ...savedEnv,
      APP_ID: "1",
      WEBHOOK_SECRET: "0123456789abcdef",
      PRIVATE_KEY: FAKE_PEM,
      PRIVATE_KEY_PATH: undefined,
      SLACK_WEBHOOK_URL: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      NOTIFY_HEALTHCHECK_REQUIRED: undefined,
      NOTIFY_HEALTHCHECK_TTL_MS: undefined,
      SETUP_ENABLED: undefined,
      SETUP_PUBLIC_URL: undefined,
      DEFAULT_CASCADE_CONFIG_FILE: undefined,
      DEFAULT_CASCADE_CONFIG_YAML: undefined,
      DIAGNOSE_TOKEN: undefined,
      NODE_ENV: "production",
      ...overrides,
    };
  }

  function parsedIssues(): Array<{ path: PropertyKey[]; message: string }> {
    const call = errorSpy.mock.calls[0]?.[0] as string | undefined;
    if (!call) throw new Error("console.error was not called");
    return JSON.parse(call).issues;
  }

  it("exits 1 on malformed SLACK_WEBHOOK_URL", async () => {
    setBaseEnv({ SLACK_WEBHOOK_URL: "not-a-url" });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(parsedIssues().some((i) => i.path.includes("SLACK_WEBHOOK_URL"))).toBe(true);
  });

  it("exits 1 when TELEGRAM_BOT_TOKEN is shorter than 40 chars", async () => {
    setBaseEnv({ TELEGRAM_BOT_TOKEN: "short" });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(parsedIssues().some((i) => i.path.includes("TELEGRAM_BOT_TOKEN"))).toBe(true);
  });

  it("exits 1 when SETUP_ENABLED=true but SETUP_PUBLIC_URL is missing", async () => {
    setBaseEnv({ SETUP_ENABLED: "true" });
    const loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const issues = parsedIssues();
    const setupIssue = issues.find((i) => i.path.join(".") === "SETUP_PUBLIC_URL");
    expect(setupIssue).toBeDefined();
    expect(setupIssue?.message).toBe("SETUP_PUBLIC_URL is required when SETUP_ENABLED=true");
  });

  it("loads ok when SETUP_ENABLED=true and SETUP_PUBLIC_URL is provided", async () => {
    setBaseEnv({ SETUP_ENABLED: "true", SETUP_PUBLIC_URL: "https://example.com" });
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.SETUP_ENABLED).toBe(true);
    expect(env.SETUP_PUBLIC_URL).toBe("https://example.com");
  });

  it("applies defaults when v1.1 vars are absent", async () => {
    setBaseEnv();
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.NOTIFY_HEALTHCHECK_REQUIRED).toBe(false);
    expect(env.NOTIFY_HEALTHCHECK_TTL_MS).toBe(900_000);
    expect(env.SETUP_ENABLED).toBe(false);
    expect(env.SETUP_PUBLIC_URL).toBeUndefined();
    expect(env.DIAGNOSE_TOKEN).toBeUndefined();
  });

  it("rejects DIAGNOSE_TOKEN shorter than 16 chars and accepts >= 16", async () => {
    setBaseEnv({ DIAGNOSE_TOKEN: "x".repeat(15) });
    let loadEnv = await importLoadEnv();
    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(parsedIssues().some((i) => i.path.includes("DIAGNOSE_TOKEN"))).toBe(true);

    vi.resetModules();
    errorSpy.mockClear();
    exitSpy.mockClear();
    setBaseEnv({ DIAGNOSE_TOKEN: "x".repeat(16) });
    loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.DIAGNOSE_TOKEN).toBe("x".repeat(16));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid TELEGRAM_BOT_TOKEN of >= 40 chars", async () => {
    setBaseEnv({ TELEGRAM_BOT_TOKEN: VALID_TG_TOKEN });
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.TELEGRAM_BOT_TOKEN).toBe(VALID_TG_TOKEN);
  });
});
