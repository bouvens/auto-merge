import { timingSafeEqual } from "node:crypto";
import type { Octokit } from "@octokit/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { Env } from "../env.js";
import type { NotifyHealthChecker } from "../notify/healthCheck.js";
import { renderMarkdown } from "./markdown.js";
import { runProbes } from "./probes.js";
import { createDiagnoseRateLimit, type DiagnoseRateLimit } from "./rateLimit.js";
import type { DiagnoseChecks, DiagnoseReport } from "./types.js";

// Single source of truth for the App permission set (D-15). PROJECT.md Constraints is the canonical spec; centralising here forces any future API-surface change to bump this in one place (and update GitHub App registration in tandem).
export const REQUIRED_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
};

export interface DiagnoseDeps {
  env: Env;
  log: Logger;
  // App-JWT-scoped client for apps.getRepoInstallation (D-04). Distinct from per-installation octokit which probes use after Step A.
  appOctokit: Octokit;
  octokitFactory: (installationId: number) => Promise<Octokit>;
  healthChecker: NotifyHealthChecker;
  // Test seam: deterministic 11-hit rate-limit assertions without 11 awaits.
  rateLimit?: DiagnoseRateLimit;
  // Test seam: stubs Octokit/msw setup; defaults to real runProbes.
  runProbesFn?: typeof runProbes;
}

// Constant-time bearer compare with length-mismatch dummy to keep wall-clock independent of secret length (D-09).
export function compareBearer(received: string, expected: string): boolean {
  const recBuf = Buffer.from(received);
  const expBuf = Buffer.from(expected);
  if (recBuf.length !== expBuf.length) {
    // Dummy compare so total time on a length-mismatch matches the success path's compare cost; the result is discarded.
    timingSafeEqual(Buffer.alloc(expBuf.length), Buffer.alloc(expBuf.length));
    return false;
  }
  return timingSafeEqual(recBuf, expBuf);
}

// Returns the token portion of a `Bearer <token>` header; undefined for any other shape so callers fall straight to 401.
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // Case-insensitive scheme match per RFC 7235; one-or-more whitespace between scheme and token.
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

interface RouteParams {
  owner: string;
  repo: string;
}

function computeOk(checks: DiagnoseChecks): boolean {
  // Object.values is sufficient — every check section in the DiagnoseChecks contract exposes `status: ProbeStatus`.
  for (const check of Object.values(checks)) {
    if (check.status === "error") return false;
  }
  return true;
}

export function registerDiagnoseRoute(app: FastifyInstance, deps: DiagnoseDeps): void {
  // Singleton per server instance — moving it into the preHandler would reset the per-IP counter every request.
  const rateLimit = deps.rateLimit ?? createDiagnoseRateLimit();
  const runner = deps.runProbesFn ?? runProbes;

  const preHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Step 1 — 503 gate (D-07). Runs first so a disabled endpoint never consumes rate-budget or touches the auth path.
    const token = deps.env.DIAGNOSE_TOKEN;
    if (!token) {
      reply.code(503).send({ error: "diagnose-disabled" });
      return;
    }

    // Step 2 — rate-limit. Pre-auth so a brute-force loop is capped at the same budget as a legitimate burst.
    const rl = rateLimit.check(req.ip);
    if (!rl.allowed) {
      if (rl.retryAfterSec !== undefined) {
        reply.header("Retry-After", String(rl.retryAfterSec));
      }
      reply.code(429).send();
      return;
    }

    // Step 3 — bearer auth. Empty 401 body — no information about which step failed leaks to an unauthenticated caller.
    const received = parseBearer(req.headers.authorization);
    if (!received || !compareBearer(received, token)) {
      reply.code(401).send();
      return;
    }
  };

  app.get<{ Params: RouteParams }>("/diagnose/:owner/:repo", { preHandler }, async (req, reply) => {
    const { owner, repo } = req.params;
    const checks = await runner({
      owner,
      repo,
      appOctokit: deps.appOctokit,
      octokitFactory: deps.octokitFactory,
      healthChecker: deps.healthChecker,
      log: deps.log,
      requiredPermissions: REQUIRED_PERMISSIONS,
    });

    const report: DiagnoseReport = {
      ok: computeOk(checks),
      owner,
      repo,
      checked_at: new Date().toISOString(),
      checks,
    };

    // Simple substring check per D-12 — full Accept-parsing would mean an extra dep for two formats.
    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/markdown")) {
      reply.type("text/markdown; charset=utf-8");
      return renderMarkdown(report);
    }
    // Always 200 — operator reads `ok` for pass/fail (D-11). 5xx would let mid-tier proxies hide the body.
    return reply.send(report);
  });
}
