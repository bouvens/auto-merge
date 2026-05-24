import { describe, expect, it, vi } from "vitest";
import { onboardRepo } from "../../src/onboarding/onboardRepo.js";

describe("onboarding/onboardRepo (RED scaffold)", () => {
  it("returns token_mint_failed when octokitFactory resolves to undefined", async () => {
    const factory = vi.fn(async () => undefined);
    const outcome = await onboardRepo({
      installationId: 111,
      owner: "acme",
      repo: "widgets",
      octokitFactory: factory,
    });
    expect(outcome).toEqual({ status: "token_mint_failed", owner: "acme", repo: "widgets" });
    expect(factory).toHaveBeenCalledWith(111);
  });
});
