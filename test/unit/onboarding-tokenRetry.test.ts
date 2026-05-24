import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import * as authModule from "../../src/auth.js";
import { getInstallationOctokitWithRetry } from "../../src/onboarding/tokenRetry.js";

vi.mock("../../src/auth.js", () => ({
  getInstallationOctokit: vi.fn(),
}));

// Helper: advance fake timers and flush microtasks so retry loop progresses.
async function tickPastBackoff(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("onboarding/tokenRetry.getInstallationOctokitWithRetry", () => {
  const installationId = 4242;
  const mockOctokit = { request: vi.fn() } as unknown as Awaited<
    ReturnType<typeof authModule.getInstallationOctokit>
  >;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(authModule.getInstallationOctokit).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns Octokit immediately on first-call success (no backoff)", async () => {
    vi.mocked(authModule.getInstallationOctokit).mockResolvedValueOnce(mockOctokit);

    const result = await getInstallationOctokitWithRetry(installationId);

    expect(result).toBe(mockOctokit);
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledWith(installationId);
  });

  it("retries once on 401 then returns Octokit after 500ms backoff", async () => {
    vi.mocked(authModule.getInstallationOctokit)
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(mockOctokit);

    const promise = getInstallationOctokitWithRetry(installationId);
    await tickPastBackoff(500);
    const result = await promise;

    expect(result).toBe(mockOctokit);
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(2);
  });

  it("retries on 404 → 404 → success after [500, 1000] backoff", async () => {
    vi.mocked(authModule.getInstallationOctokit)
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce(mockOctokit);

    const promise = getInstallationOctokitWithRetry(installationId);
    await tickPastBackoff(500);
    await tickPastBackoff(1000);
    const result = await promise;

    expect(result).toBe(mockOctokit);
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(3);
  });

  it("returns undefined and logs after 4 consecutive 401s", async () => {
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.mocked(authModule.getInstallationOctokit)
      .mockRejectedValueOnce({ status: 401 })
      .mockRejectedValueOnce({ status: 401 })
      .mockRejectedValueOnce({ status: 401 })
      .mockRejectedValueOnce({ status: 401 });

    const promise = getInstallationOctokitWithRetry(installationId);
    await tickPastBackoff(500);
    await tickPastBackoff(1000);
    await tickPastBackoff(2000);
    const result = await promise;

    expect(result).toBeUndefined();
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(4);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    const [payload] = logErrorSpy.mock.calls[0];
    expect(payload).toMatchObject({
      event: "onboard_token_mint_failed",
      installation_id: installationId,
      attempt: 3,
    });
  });

  it("fails fast on non-transient 500 status without retry", async () => {
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.mocked(authModule.getInstallationOctokit).mockRejectedValueOnce({ status: 500 });

    const result = await getInstallationOctokitWithRetry(installationId);

    expect(result).toBeUndefined();
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy.mock.calls[0][0]).toMatchObject({
      event: "onboard_token_mint_failed",
      installation_id: installationId,
      attempt: 0,
    });
  });

  it("fails fast on non-transient 403 status without retry", async () => {
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.mocked(authModule.getInstallationOctokit).mockRejectedValueOnce({ status: 403 });

    const result = await getInstallationOctokitWithRetry(installationId);

    expect(result).toBeUndefined();
    expect(vi.mocked(authModule.getInstallationOctokit)).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
  });
});
