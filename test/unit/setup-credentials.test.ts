import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkStaleOnBoot,
  createCredentialsStore,
  formatEnvFile,
  TTL_MS,
} from "../../src/setup/credentials.js";

function makeLog(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nLINE\n-----END RSA PRIVATE KEY-----\n";

describe("formatEnvFile", () => {
  it("emits header lines, APP_ID, WEBHOOK_SECRET, quoted PRIVATE_KEY with literal newlines", () => {
    const body = formatEnvFile({ id: 42, webhook_secret: "abc123", pem: PEM });

    const lines = body.split("\n");
    expect(lines[0]?.startsWith("#")).toBe(true);
    expect(lines.some((l) => l.startsWith("#") && /do not commit/i.test(l))).toBe(true);

    expect(body).toContain("APP_ID=42");
    expect(body).toContain("WEBHOOK_SECRET=abc123");

    // Quoted multi-line form is the only dotenv-compatible way to embed PEM newlines.
    expect(body).toContain(
      'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nLINE\n-----END RSA PRIVATE KEY-----\n"',
    );
  });

  it("escapes literal double-quotes inside the PEM", () => {
    const pemWithQuote = '-----BEGIN-----\nhas a " inside\n-----END-----\n';
    const body = formatEnvFile({ id: 1, webhook_secret: "s", pem: pemWithQuote });
    expect(body).toContain('has a \\" inside');
  });

  it("output ends with a trailing newline", () => {
    const body = formatEnvFile({ id: 1, webhook_secret: "s", pem: PEM });
    expect(body.endsWith("\n")).toBe(true);
  });

  it("throws when webhook_secret is null", () => {
    expect(() =>
      formatEnvFile({
        id: 1,
        webhook_secret: null as unknown as string,
        pem: PEM,
      }),
    ).toThrow(/webhook_secret/);
  });
});

describe("createCredentialsStore", () => {
  let dir: string;
  let log: pino.Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), "setup-credentials-"));
    log = makeLog();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("getPath returns join(dir, credentials.env)", () => {
    const store = createCredentialsStore({ dir, log });
    expect(store.getPath()).toBe(join(dir, "credentials.env"));
  });

  it("exists() is false before persist, true after", () => {
    const store = createCredentialsStore({ dir, log });
    expect(store.exists()).toBe(false);
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    expect(store.exists()).toBe(true);
  });

  it("persist writes file with mode 0o600", () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    const mode = statSync(store.getPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persist is idempotent — second call overwrites with second payload's content", () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "first", pem: PEM });
    store.persist({ id: 2, webhook_secret: "second", pem: PEM });
    const body = store.read()?.toString("utf8") ?? "";
    expect(body).toContain("APP_ID=2");
    expect(body).toContain("WEBHOOK_SECRET=second");
    expect(body).not.toContain("WEBHOOK_SECRET=first");
  });

  it("read() returns Buffer when present, null when ENOENT", () => {
    const store = createCredentialsStore({ dir, log });
    expect(store.read()).toBeNull();
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    const buf = store.read();
    expect(buf).not.toBeNull();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf?.toString("utf8")).toContain("APP_ID=1");
  });

  it("delete() unlinks the file and logs setup_credentials_deleted", () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    store.delete();
    expect(store.exists()).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "setup_credentials_deleted" }),
      "setup",
    );
  });

  it("delete() swallows ENOENT silently (no throw, no error log)", () => {
    const store = createCredentialsStore({ dir, log });
    expect(() => store.delete()).not.toThrow();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("TTL fires after 3_600_000ms — file unlinked + setup_credentials_expired logged", async () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    expect(store.exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(TTL_MS);

    expect(store.exists()).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "setup_credentials_expired" }),
      "setup",
    );
  });

  it("manual delete then TTL fires — ENOENT swallowed without warn", async () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    store.delete();

    await vi.advanceTimersByTimeAsync(TTL_MS);

    const warnCalls = (log.warn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const ttlWarnCalled = warnCalls.some(
      (c) => (c[0] as { event?: string })?.event === "setup_ttl_unlink_failed",
    );
    expect(ttlWarnCalled).toBe(false);
  });

  it("tmp file lives in same directory as final (Pitfall 2 EXDEV guard)", () => {
    const store = createCredentialsStore({ dir, log });
    store.persist({ id: 1, webhook_secret: "s", pem: PEM });
    // After successful persist+rename the tmp must not linger.
    const tmpPath = `${store.getPath()}.tmp-${process.pid}`;
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe("checkStaleOnBoot", () => {
  let dir: string;
  let log: pino.Logger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "setup-stale-"));
    log = makeLog();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("no credentials.env present → no throw, no log", () => {
    expect(() => checkStaleOnBoot(dir, log)).not.toThrow();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("stale file (mtime > TTL ago) → unlink + setup_stale_cleanup logged", () => {
    const path = join(dir, "credentials.env");
    writeFileSync(path, "stale", { mode: 0o600 });
    const past = new Date(Date.now() - TTL_MS - 60_000);
    utimesSync(path, past, past);

    checkStaleOnBoot(dir, log);

    expect(existsSync(path)).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "setup_stale_cleanup", path }),
      "setup",
    );
  });

  it("fresh file (mtime within TTL) → not unlinked, no log", () => {
    const path = join(dir, "credentials.env");
    writeFileSync(path, "fresh", { mode: 0o600 });

    checkStaleOnBoot(dir, log);

    expect(existsSync(path)).toBe(true);
    const infoCalls = (log.info as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const staleCalled = infoCalls.some(
      (c) => (c[0] as { event?: string })?.event === "setup_stale_cleanup",
    );
    expect(staleCalled).toBe(false);
  });

  it("non-ENOENT statSync error is re-thrown (boot-time misconfig surfaces to operator)", () => {
    const filePath = join(dir, "regular-file");
    writeFileSync(filePath, "x");
    const badDir = join(filePath, "subdir");
    expect(() => checkStaleOnBoot(badDir, log)).toThrow();
  });
});
