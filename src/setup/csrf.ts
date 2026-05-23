import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../env.js";

export const STATE_COOKIE_NAME = "auto_merge_setup_state";
export const DOWNLOAD_COOKIE_NAME = "auto_merge_setup_download";

const STATE_MAX_AGE_SECONDS = 600;
const DOWNLOAD_MAX_AGE_SECONDS = 300;
const COOKIE_PATH = "/setup";

type EnvLike = Pick<Env, "NODE_ENV">;

interface BuildCookieOpts {
  name: string;
  value: string;
  maxAgeSeconds: number;
  env: EnvLike;
}

// Secure attribute only in production so localhost-HTTP smoke remains usable (D-07).
function buildCookieHeader({ name, value, maxAgeSeconds, env }: BuildCookieOpts): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=${COOKIE_PATH}; HttpOnly${secure}; SameSite=Lax`;
}

function buildClearHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax`;
}

export function setStateCookie(reply: FastifyReply, env: EnvLike, value: string): void {
  reply.header(
    "Set-Cookie",
    buildCookieHeader({ name: STATE_COOKIE_NAME, value, maxAgeSeconds: STATE_MAX_AGE_SECONDS, env }),
  );
}

export function clearStateCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", buildClearHeader(STATE_COOKIE_NAME));
}

export function setDownloadCookie(reply: FastifyReply, env: EnvLike, value: string): void {
  reply.header(
    "Set-Cookie",
    buildCookieHeader({
      name: DOWNLOAD_COOKIE_NAME,
      value,
      maxAgeSeconds: DOWNLOAD_MAX_AGE_SECONDS,
      env,
    }),
  );
}

export function clearDownloadCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", buildClearHeader(DOWNLOAD_COOKIE_NAME));
}

// Manual split-on-`;` parse handles the canonical multi-cookie Cookie header without pulling @fastify/cookie.
function readNamedCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie as string | undefined;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

export function readStateCookie(req: FastifyRequest): string | undefined {
  return readNamedCookie(req, STATE_COOKIE_NAME);
}

export function readDownloadCookie(req: FastifyRequest): string | undefined {
  return readNamedCookie(req, DOWNLOAD_COOKIE_NAME);
}

// timingSafeEqual throws on length mismatch — short-circuit BEFORE the call so an attacker cannot trigger it.
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
