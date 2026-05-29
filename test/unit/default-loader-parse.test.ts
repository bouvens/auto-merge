import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfigLoader } from "../../src/config/defaultLoader.js";
import { makeExitStub } from "../../src/shutdown.js";

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

const VALID_YAML = "main_branch: main\ndev_branch: dev\n";

describe("createDefaultConfigLoader — boot/parse paths", () => {
  let tmpDir: string;
  let activeLoader: { stop: () => void } | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "default-config-parse-"));
    activeLoader = undefined;
  });

  afterEach(async () => {
    activeLoader?.stop();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("FILE set with valid YAML → get() returns file_default", async () => {
    const filePath = join(tmpDir, "default.yml");
    await writeFile(filePath, VALID_YAML, "utf8");
    const log = makeLog();
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
      makeExitStub(),
    );
    activeLoader = loader;
    const got = loader.get();
    expect(got?.source).toBe("file_default");
    expect(got?.config).toEqual({ main_branch: "main", dev_branch: "dev", conflict_pr: true });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "default_config_loaded",
        source: "file_default",
        path: filePath,
      }),
      expect.any(String),
    );
  });

  it("YAML inline with valid content → get() returns env_default; no path logged", () => {
    const log = makeLog();
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_YAML: VALID_YAML, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
      makeExitStub(),
    );
    activeLoader = loader;
    const got = loader.get();
    expect(got?.source).toBe("env_default");
    expect(got?.config).toEqual({ main_branch: "main", dev_branch: "dev", conflict_pr: true });
    const infoCall = (log.info as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "default_config_loaded",
    );
    expect(infoCall).toBeDefined();
    const payload = infoCall?.[0] as Record<string, unknown>;
    expect(payload.source).toBe("env_default");
    expect(payload.path).toBeUndefined();
    expect(() => loader.stop()).not.toThrow();
  });

  it("Both FILE and YAML set → FILE wins; warn emitted once", async () => {
    const filePath = join(tmpDir, "default.yml");
    await writeFile(filePath, VALID_YAML, "utf8");
    const log = makeLog();
    const loader = createDefaultConfigLoader(
      {
        DEFAULT_CASCADE_CONFIG_FILE: filePath,
        DEFAULT_CASCADE_CONFIG_YAML: "main_branch: alt\ndev_branch: alt-dev\n",
        DEFAULT_CONFIG_RELOAD_MS: 60_000,
      },
      log,
      makeExitStub(),
    );
    activeLoader = loader;
    expect(loader.get()?.source).toBe("file_default");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "default_config_yaml_ignored" }),
      expect.any(String),
    );
  });

  it("FILE set but path does not exist → exit(1) + log.fatal", () => {
    const filePath = join(tmpDir, "missing.yml");
    const log = makeLog();
    expect(() =>
      createDefaultConfigLoader(
        { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
        log,
        makeExitStub(),
      ),
    ).toThrow(/exit:1/);
    expect(log.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "default_config_file_missing_at_boot",
        path: filePath,
      }),
      expect.any(String),
    );
  });

  it("YAML set + invalid YAML (zod-reject) → exit(1) + log.fatal with errors", () => {
    const log = makeLog();
    expect(() =>
      createDefaultConfigLoader(
        {
          DEFAULT_CASCADE_CONFIG_YAML: "main_branch: only\n",
          DEFAULT_CONFIG_RELOAD_MS: 60_000,
        },
        log,
        makeExitStub(),
      ),
    ).toThrow(/exit:1/);
    expect(log.fatal).toHaveBeenCalledTimes(1);
    const call = (log.fatal as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call?.[0] as { event: string; source: string; errors: unknown[] };
    expect(payload.event).toBe("default_config_invalid");
    expect(payload.source).toBe("env");
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it("Neither env set → get() returns undefined; stop() is a no-op", () => {
    const log = makeLog();
    const loader = createDefaultConfigLoader(
      { DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
      makeExitStub(),
    );
    expect(loader.get()).toBeUndefined();
    expect(() => loader.stop()).not.toThrow();
    expect(log.info).not.toHaveBeenCalled();
  });
});
