import { utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfigLoader } from "../../src/config/defaultLoader.js";

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
const VALID_YAML_V2 = "main_branch: main\ndev_branch: develop\n";
const INVALID_YAML = "main_branch: main\n\t bad: : :";
const RELOAD_MS = 60_000;

// Push mtime forward to a real future Date so stat.mtimeMs > lastMtime regardless of fake timers.
function bump(file: string, deltaMs: number): void {
  const future = new Date(Date.now() + deltaMs);
  utimesSync(file, future, future);
}

describe("createDefaultConfigLoader — hot-reload tick paths", () => {
  let tmpDir: string;
  let filePath: string;
  let log: pino.Logger;
  let activeLoader: { stop: () => void } | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "default-config-hot-"));
    filePath = join(tmpDir, "default.yml");
    log = makeLog();
    activeLoader = undefined;
  });

  afterEach(async () => {
    activeLoader?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("mtime bump + valid YAML → swaps config + logs default_config_reloaded", async () => {
    await writeFile(filePath, VALID_YAML, "utf8");
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: RELOAD_MS },
      log,
    );
    activeLoader = loader;
    expect(loader.get()?.config.dev_branch).toBe("dev");

    await writeFile(filePath, VALID_YAML_V2, "utf8");
    bump(filePath, 5000);
    await vi.advanceTimersByTimeAsync(RELOAD_MS);

    expect(loader.get()?.config.dev_branch).toBe("develop");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "default_config_reloaded", path: filePath }),
      expect.any(String),
    );
  });

  it("mtime bump + invalid YAML → swap rejected; last-known-good retained; log.error", async () => {
    await writeFile(filePath, VALID_YAML, "utf8");
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: RELOAD_MS },
      log,
    );
    activeLoader = loader;

    await writeFile(filePath, INVALID_YAML, "utf8");
    bump(filePath, 5000);
    await vi.advanceTimersByTimeAsync(RELOAD_MS);

    expect(loader.get()?.config.dev_branch).toBe("dev");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "default_config_reload_failed", path: filePath }),
      expect.any(String),
    );
  });

  it("file deleted mid-flight → last-known-good retained; log.error file_missing", async () => {
    await writeFile(filePath, VALID_YAML, "utf8");
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: RELOAD_MS },
      log,
    );
    activeLoader = loader;

    await rm(filePath);
    await vi.advanceTimersByTimeAsync(RELOAD_MS);

    expect(loader.get()?.config.dev_branch).toBe("dev");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "default_config_file_missing", path: filePath }),
      expect.any(String),
    );
  });

  it("mtime unchanged → tick is a no-op (no reload log, config unchanged)", async () => {
    await writeFile(filePath, VALID_YAML, "utf8");
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: RELOAD_MS },
      log,
    );
    activeLoader = loader;
    const infoMock = log.info as unknown as ReturnType<typeof vi.fn>;
    infoMock.mockClear();

    await vi.advanceTimersByTimeAsync(RELOAD_MS * 3);

    const reloadCalls = infoMock.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === "default_config_reloaded",
    );
    expect(reloadCalls.length).toBe(0);
    expect(loader.get()?.config.dev_branch).toBe("dev");
  });

  it("stop() halts ticks — subsequent file change is ignored", async () => {
    await writeFile(filePath, VALID_YAML, "utf8");
    const loader = createDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: RELOAD_MS },
      log,
    );
    activeLoader = loader;
    loader.stop();

    await writeFile(filePath, VALID_YAML_V2, "utf8");
    bump(filePath, 5000);
    const infoMock = log.info as unknown as ReturnType<typeof vi.fn>;
    infoMock.mockClear();
    await vi.advanceTimersByTimeAsync(RELOAD_MS * 2);

    const reloadCalls = infoMock.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === "default_config_reloaded",
    );
    expect(reloadCalls.length).toBe(0);
    expect(loader.get()?.config.dev_branch).toBe("dev");
  });
});
