import { describe, expect, it } from "vitest";
import {
  type BotIdentity,
  checkLoop,
  type LoopCheckPayload,
} from "../../src/cascade/loopPrevention.js";

const bot: BotIdentity = {
  login: "my-app[bot]",
  email: "41898282+my-app[bot]@users.noreply.github.com",
};

function payload(overrides: {
  sender?: string;
  email?: string | null;
  message?: string | null;
  nullHead?: boolean;
}): LoopCheckPayload {
  if (overrides.nullHead) {
    return {
      sender: { login: overrides.sender ?? "someone" },
      head_commit: null,
    };
  }
  return {
    sender: { login: overrides.sender ?? "someone" },
    head_commit: {
      author: { email: overrides.email ?? "user@example.com" },
      message: overrides.message ?? "regular commit",
    },
  };
}

describe("checkLoop", () => {
  it("sender match only", () => {
    expect(checkLoop(payload({ sender: bot.login }), bot)).toEqual({
      skip: true,
      reasons: ["sender"],
    });
  });

  it("author_email match only (case-insensitive)", () => {
    const p = payload({ email: bot.email.toUpperCase() });
    expect(checkLoop(p, bot)).toEqual({
      skip: true,
      reasons: ["author_email"],
    });
  });

  it("trailer match on multi-line commit message (line 5)", () => {
    const p = payload({
      message: "feat: x\n\nbody line one\nbody line two\nAuto-Merge: cascade abc",
    });
    expect(checkLoop(p, bot)).toEqual({ skip: true, reasons: ["trailer"] });
  });

  it("trailer does NOT match lowercase auto-merge (case-sensitive)", () => {
    const p = payload({ message: "feat: x\n\nauto-merge: cascade abc" });
    expect(checkLoop(p, bot)).toEqual({ skip: false, reasons: [] });
  });

  it("all three match → reasons in insertion order", () => {
    const p = payload({
      sender: bot.login,
      email: bot.email,
      message: "Auto-Merge: cascade x",
    });
    expect(checkLoop(p, bot)).toEqual({
      skip: true,
      reasons: ["sender", "author_email", "trailer"],
    });
  });

  it("no match", () => {
    expect(checkLoop(payload({}), bot)).toEqual({ skip: false, reasons: [] });
  });

  it("null head_commit + sender match → skip with ['sender']", () => {
    expect(checkLoop(payload({ sender: bot.login, nullHead: true }), bot)).toEqual({
      skip: true,
      reasons: ["sender"],
    });
  });

  it("null head_commit + no sender match → no skip, no crash", () => {
    expect(checkLoop(payload({ nullHead: true }), bot)).toEqual({
      skip: false,
      reasons: [],
    });
  });
});
