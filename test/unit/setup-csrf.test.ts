import * as nodeCrypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  clearDownloadCookie,
  clearStateCookie,
  DOWNLOAD_COOKIE_NAME,
  readDownloadCookie,
  readStateCookie,
  safeEqualHex,
  setDownloadCookie,
  setStateCookie,
  STATE_COOKIE_NAME,
} from "../../src/setup/csrf.js";

type HeaderMap = Map<string, string>;

function makeReply(): { reply: FastifyReply; headers: HeaderMap } {
  const headers: HeaderMap = new Map();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, headers };
}

function makeRequest(cookieHeader?: string): FastifyRequest {
  return { headers: { cookie: cookieHeader } } as unknown as FastifyRequest;
}

describe("setup/csrf constants", () => {
  it("STATE_COOKIE_NAME is the locked literal", () => {
    expect(STATE_COOKIE_NAME).toBe("auto_merge_setup_state");
  });

  it("DOWNLOAD_COOKIE_NAME is the locked literal", () => {
    expect(DOWNLOAD_COOKIE_NAME).toBe("auto_merge_setup_download");
  });
});

describe("setup/csrf state cookie", () => {
  it("setStateCookie writes HttpOnly + SameSite=Lax + Max-Age=600 + Path=/setup with correct name", () => {
    const { reply, headers } = makeReply();
    setStateCookie(reply, { NODE_ENV: "development" }, "abc-123");
    const sc = headers.get("set-cookie");
    expect(sc).toBeDefined();
    expect(sc).toContain("auto_merge_setup_state=abc-123");
    expect(sc).toContain("Max-Age=600");
    expect(sc).toContain("Path=/setup");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
  });

  it("setStateCookie omits Secure outside production", () => {
    const { reply, headers } = makeReply();
    setStateCookie(reply, { NODE_ENV: "development" }, "x");
    expect(headers.get("set-cookie")).not.toContain("Secure");
  });

  it("setStateCookie includes Secure when NODE_ENV=production", () => {
    const { reply, headers } = makeReply();
    setStateCookie(reply, { NODE_ENV: "production" }, "x");
    expect(headers.get("set-cookie")).toContain("Secure");
  });

  it("clearStateCookie writes Max-Age=0 with the same Path", () => {
    const { reply, headers } = makeReply();
    clearStateCookie(reply);
    const sc = headers.get("set-cookie");
    expect(sc).toContain("auto_merge_setup_state=");
    expect(sc).toContain("Max-Age=0");
    expect(sc).toContain("Path=/setup");
  });

  it("readStateCookie returns the value from a multi-cookie Cookie header", () => {
    const req = makeRequest("foo=bar; auto_merge_setup_state=abc; baz=qux");
    expect(readStateCookie(req)).toBe("abc");
  });

  it("readStateCookie returns undefined when the cookie is absent but header exists", () => {
    const req = makeRequest("foo=bar; baz=qux");
    expect(readStateCookie(req)).toBeUndefined();
  });

  it("readStateCookie returns undefined when the Cookie header is absent", () => {
    const req = makeRequest(undefined);
    expect(readStateCookie(req)).toBeUndefined();
  });

  it("setStateCookie → readStateCookie roundtrip recovers the value", () => {
    const { reply, headers } = makeReply();
    setStateCookie(reply, { NODE_ENV: "development" }, "round-trip-value");
    const setCookie = headers.get("set-cookie") ?? "";
    // Extract just the "name=value" pair from the Set-Cookie header to feed back as a Cookie request header.
    const firstPart = setCookie.split(";", 1)[0];
    const req = makeRequest(firstPart);
    expect(readStateCookie(req)).toBe("round-trip-value");
  });
});

describe("setup/csrf download cookie", () => {
  it("setDownloadCookie uses Max-Age=300 and the download name", () => {
    const { reply, headers } = makeReply();
    setDownloadCookie(reply, { NODE_ENV: "development" }, "dl-1");
    const sc = headers.get("set-cookie");
    expect(sc).toContain("auto_merge_setup_download=dl-1");
    expect(sc).toContain("Max-Age=300");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/setup");
  });

  it("clearDownloadCookie sets Max-Age=0", () => {
    const { reply, headers } = makeReply();
    clearDownloadCookie(reply);
    expect(headers.get("set-cookie")).toContain("Max-Age=0");
    expect(headers.get("set-cookie")).toContain("auto_merge_setup_download=");
  });

  it("readDownloadCookie roundtrips", () => {
    const { reply, headers } = makeReply();
    setDownloadCookie(reply, { NODE_ENV: "development" }, "dl-roundtrip");
    const firstPart = (headers.get("set-cookie") ?? "").split(";", 1)[0];
    const req = makeRequest(firstPart);
    expect(readDownloadCookie(req)).toBe("dl-roundtrip");
  });

  it("readDownloadCookie returns undefined when cookie missing", () => {
    expect(readDownloadCookie(makeRequest("other=1"))).toBeUndefined();
  });
});

describe("setup/csrf.safeEqualHex", () => {
  it("returns true for equal strings", () => {
    expect(safeEqualHex("abc", "abc")).toBe(true);
  });

  it("returns false for different equal-length strings", () => {
    expect(safeEqualHex("abc", "abd")).toBe(false);
  });

  it("returns false for differing-length inputs WITHOUT throwing", () => {
    expect(() => safeEqualHex("ab", "cde")).not.toThrow();
    expect(safeEqualHex("ab", "cde")).toBe(false);
  });

  it("delegates equal-length compare to crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(nodeCrypto, "timingSafeEqual");
    safeEqualHex("zz", "zz");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
