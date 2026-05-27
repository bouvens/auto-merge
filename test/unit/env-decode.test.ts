import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----";

describe("decodeMaybeBase64Pem", () => {
  async function importDecode() {
    const mod = await import("../../src/env.js");
    return mod.decodeMaybeBase64Pem;
  }

  it("returns raw PEM unchanged when input already contains -----BEGIN", async () => {
    const decode = await importDecode();
    expect(decode(FAKE_PEM)).toBe(FAKE_PEM);
  });

  it("decodes base64-encoded PEM to raw PEM", async () => {
    const decode = await importDecode();
    const b64 = Buffer.from(FAKE_PEM).toString("base64");
    expect(decode(b64)).toBe(FAKE_PEM);
  });

  it("returns garbage non-base64 string unchanged", async () => {
    const decode = await importDecode();
    const garbage = "not-base64-and-not-pem-content";
    expect(decode(garbage)).toBe(garbage);
  });

  it("returns empty string unchanged", async () => {
    const decode = await importDecode();
    expect(decode("")).toBe("");
  });

  it("handles whitespace-wrapped base64 (macOS base64 wraps at 76 chars by default)", async () => {
    const decode = await importDecode();
    // Node Buffer.from ignores non-base64 chars so newline-wrapped base64 still decodes correctly.
    const wrapped = Buffer.from(FAKE_PEM)
      .toString("base64")
      .replace(/(.{64})/g, "$1\n");
    expect(decode(wrapped)).toBe(FAKE_PEM);
  });
});

describe("loadEnv with base64 PEM", () => {
  let _exitSpy: ReturnType<typeof vi.spyOn>;
  let savedEnv: NodeJS.ProcessEnv;
  let tmpDir: string;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    tmpDir = await mkdtemp(join(tmpdir(), "env-decode-test-"));
    _exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  function setBaseEnv(overrides: Record<string, string | undefined> = {}) {
    process.env = {
      ...savedEnv,
      APP_ID: "1",
      WEBHOOK_SECRET: "0123456789abcdef",
      PRIVATE_KEY: undefined,
      PRIVATE_KEY_PATH: undefined,
      NODE_ENV: "production",
      ...overrides,
    };
  }

  it("resolves PRIVATE_KEY from base64-encoded PEM to raw PEM", async () => {
    const b64 = Buffer.from(FAKE_PEM).toString("base64");
    setBaseEnv({ PRIVATE_KEY: b64 });
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.PRIVATE_KEY).toBe(FAKE_PEM);
  });

  it("resolves PRIVATE_KEY_PATH pointing to a file containing base64 PEM to raw PEM", async () => {
    const keyFile = join(tmpDir, "key.b64.pem");
    await writeFile(keyFile, Buffer.from(FAKE_PEM).toString("base64"), "utf8");
    setBaseEnv({ PRIVATE_KEY_PATH: keyFile });
    const loadEnv = await importLoadEnv();
    const env = loadEnv();
    expect(env.PRIVATE_KEY).toBe(FAKE_PEM);
  });
});
