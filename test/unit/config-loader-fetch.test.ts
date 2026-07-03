import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cascade/checkRun.js", () => ({
  createFailureCheckRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/config/defaultLoader.js", () => ({ getDefaultConfig: vi.fn(() => undefined) }));

import { createFailureCheckRun } from "../../src/cascade/checkRun.js";
import { loadConfig } from "../../src/config/loader.js";
import { log } from "../../src/log.js";

const createFailureCheckRunMock = vi.mocked(createFailureCheckRun);

function makeErrOctokit(status?: number) {
  const err = Object.assign(new Error("boom"), status === undefined ? {} : { status });
  return { request: vi.fn().mockRejectedValue(err) } as never;
}

const makeNotify = () => ({ notify: vi.fn().mockResolvedValue(undefined) });

async function run(octokit: ReturnType<typeof makeErrOctokit>, sha: string) {
  const notify = makeNotify();
  const result = await loadConfig({
    octokit,
    owner: "acme",
    repo: "widgets",
    sha,
    installation_id: 1,
    notify,
  });
  return { result, notify };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("loadConfig — transient upstream failure must not alert as invalid config", () => {
  it.each([
    ["500 (GitHub Unicorn)", 500, "sha-500"],
    ["502", 502, "sha-502"],
    ["429 (rate limit)", 429, "sha-429"],
    ["network error / no HTTP status", undefined, "sha-net"],
  ])("%s → no notify, no Check Run, returns errors", async (_label, status, sha) => {
    const { result, notify } = await run(makeErrOctokit(status), sha);
    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(notify.notify).not.toHaveBeenCalled();
    expect(createFailureCheckRunMock).not.toHaveBeenCalled();
  });

  it("genuine 403 (permission/auth) → alerts config_invalid + Check Run", async () => {
    const { result, notify } = await run(makeErrOctokit(403), "sha-403");
    expect(result.config).toBeUndefined();
    expect(notify.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "config_invalid" }));
    expect(createFailureCheckRunMock).toHaveBeenCalled();
  });
});
