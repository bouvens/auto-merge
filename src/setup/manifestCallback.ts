import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/core";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { getAnonymousOctokit } from "../auth.js";
import type { Env } from "../env.js";
import type { CredentialsPayload, CredentialsStore } from "./credentials.js";
import {
  clearDownloadCookie,
  clearStateCookie,
  readDownloadCookie,
  readStateCookie,
  safeEqualHex,
  setDownloadCookie,
} from "./csrf.js";
import { escapeHtml } from "./html.js";

// Inline CSS mirrors the manifest form / warning page aesthetic (D-15) — single declarative block, no external assets.
const INLINE_CSS = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; }
  dt { font-weight: 600; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.3em; border-radius: 3px; }
  .ok { border-left: 4px solid #059669; padding: 0.5rem 1rem; background: rgba(5,150,105,0.08); }
  button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
`;

// Stars-only sentinel preserves the redacted shape when the source is too short — never leak the raw bytes (D-16, T-08-21).
const STARS = "****";

export function redactTail(value: string | undefined, tailLen: number): string {
  if (!value || value.length < tailLen) return STARS;
  return STARS + value.slice(-tailLen);
}

// Extract last 4 chars of a PEM's base64 body — strip BEGIN/END markers + whitespace before taking the tail (D-16).
function pemTail(pem: string | undefined): string {
  if (!pem) return STARS;
  const body = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");
  return redactTail(body, 4);
}

export interface SuccessPageInfo {
  appId: number;
  webhookSecretTail: string;
  pemTail: string;
  slug?: string;
  htmlUrl?: string;
}

export function renderSuccessPage(info: SuccessPageInfo): string {
  // Caller is responsible for passing already-redacted tails — escapeHtml only guards against unexpected `<` inside slug/htmlUrl.
  const slug = info.slug ? escapeHtml(info.slug) : "";
  const htmlUrl = info.htmlUrl ? escapeHtml(info.htmlUrl) : "";
  const webhookTail = escapeHtml(info.webhookSecretTail);
  const pemTailEscaped = escapeHtml(info.pemTail);

  const slugRow = slug ? `<dt>Slug</dt><dd><code>${slug}</code></dd>` : "";
  const linkRow = htmlUrl
    ? `<dt>App URL</dt><dd><a href="${htmlUrl}" target="_blank" rel="noopener noreferrer">${htmlUrl}</a></dd>`
    : "";

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>auto-merge — setup завершён</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<div class="ok">
<h1>GitHub App создан</h1>
<p>Credentials сохранены на диск инстанса. Скачайте файл и положите его в secret store вашей платформы (k8s Secret, Compose env-file, и т.п.).</p>
</div>
<h2>Параметры App'а</h2>
<dl>
<dt>APP_ID</dt><dd><code>${info.appId}</code></dd>
${slugRow}
<dt>WEBHOOK_SECRET</dt><dd><code>${webhookTail}</code></dd>
<dt>PRIVATE_KEY</dt><dd><code>${pemTailEscaped}</code></dd>
${linkRow}
</dl>
<h2>Скачать credentials.env</h2>
<p>Файл доступен в течение 5 минут после открытия этой страницы (одноразовая ссылка).</p>
<form action="/setup/credentials.env" method="get">
<button type="submit">Скачать .env</button>
</form>
</body>
</html>`;
}

const HTML_HEADERS = {
  contentType: "text/html; charset=utf-8",
  cacheControl: "no-store, must-revalidate",
} as const;

interface CallbackQuery {
  code?: string;
  state?: string;
}

// Conversion response shape per RESEARCH §Pattern 2 — `id`, `pem`, `webhook_secret` are the load-bearing fields; rest are advisory.
interface ConversionResponseData {
  id: number;
  pem: string;
  webhook_secret: string;
  client_id?: string;
  client_secret?: string;
  slug?: string;
  html_url?: string;
}

interface CallbackDeps {
  env: Env;
  log: pino.Logger;
  credentials: CredentialsStore;
  // Injectable for tests; defaults to the project-wide anonymous Octokit factory (D-20).
  octokitFactory?: () => InstanceType<typeof Octokit>;
}

interface DownloadDeps {
  env: Env;
  log: pino.Logger;
  credentials: CredentialsStore;
}

// Strict-order callback: CSRF → conversion → persist → render (D-05 + Pitfall 2). Refresh path skips conversion (Pitfall 1: code is single-use, 1h TTL).
export function registerManifestCallbackRoute(app: FastifyInstance, deps: CallbackDeps): void {
  const factory = deps.octokitFactory ?? getAnonymousOctokit;

  app.get("/setup/callback", async (req, reply) => {
    const query = (req.query ?? {}) as CallbackQuery;
    const cookie = readStateCookie(req);
    const stateOk =
      Boolean(cookie) && Boolean(query.state) && safeEqualHex(cookie ?? "", query.state ?? "");

    if (!stateOk) {
      // Presence flags only — never log the cookie or query.state values themselves (D-09, T-08-19).
      deps.log.warn(
        {
          event: "setup_csrf_mismatch",
          has_cookie: Boolean(cookie),
          has_query_state: Boolean(query.state),
        },
        "setup",
      );
      clearStateCookie(reply);
      return reply.code(400).send({ error: "csrf_mismatch" });
    }

    if (!query.code) {
      return reply.code(400).send({ error: "missing_code" });
    }

    // Refresh-idempotency path: credentials already on disk → skip conversion (Pitfall 1) and re-render from disk.
    let payload: CredentialsPayload | undefined;
    if (!deps.credentials.exists()) {
      const octokit = factory();
      let data: ConversionResponseData;
      try {
        const resp = await octokit.request("POST /app-manifests/{code}/conversions", {
          code: query.code,
        });
        data = resp.data as ConversionResponseData;
      } catch (err) {
        // Log the error string, not the full Error object — RequestError carries the response body which may include sensitive fields.
        deps.log.error({ event: "setup_conversion_failed", err: String(err) }, "setup");
        return reply.code(502).send({ error: "conversion_failed" });
      }

      const next: CredentialsPayload = {
        id: data.id,
        webhook_secret: data.webhook_secret,
        pem: data.pem,
        client_id: data.client_id,
        client_secret: data.client_secret,
        slug: data.slug,
        html_url: data.html_url,
      };

      try {
        deps.credentials.persist(next);
      } catch (err) {
        // app_id logged so the operator can manually delete the orphaned App on github.com (T-08-25).
        deps.log.error(
          { event: "setup_persist_failed", err: String(err), app_id: data.id },
          "setup",
        );
        return reply.code(500).send({ error: "persist_failed" });
      }

      deps.log.info(
        {
          event: "setup_completed",
          app_id: data.id,
          slug: data.slug,
          html_url: data.html_url,
        },
        "setup",
      );
      payload = next;
    }

    // Symmetrise refresh path with happy path by re-reading from disk; renderSuccessPage runs strictly AFTER persist (Pitfall 2 mitigation).
    if (!payload) {
      // Refresh-path payload reconstruction from disk — parse the .env body for APP_ID + slug; secrets stay on disk.
      const fileBuf = deps.credentials.read();
      if (!fileBuf) {
        // Race: file vanished between exists() and read(); fail closed.
        deps.log.error({ event: "setup_disk_disappeared" }, "setup");
        return reply.code(500).send({ error: "persist_failed" });
      }
      payload = parseCredentialsEnv(fileBuf.toString("utf8"));
    }

    clearStateCookie(reply);
    setDownloadCookie(reply, deps.env, randomUUID());

    return reply
      .type(HTML_HEADERS.contentType)
      .header("Cache-Control", HTML_HEADERS.cacheControl)
      .send(
        renderSuccessPage({
          appId: payload.id,
          webhookSecretTail: redactTail(payload.webhook_secret, 4),
          pemTail: pemTail(payload.pem),
          slug: payload.slug,
          htmlUrl: payload.html_url,
        }),
      );
  });
}

// Minimal parser for refresh-path render — extracts APP_ID + slug-equivalent. PEM tail is computed from the quoted block; webhook tail from raw line.
function parseCredentialsEnv(body: string): CredentialsPayload {
  const idMatch = body.match(/^APP_ID=(\d+)/m);
  const whMatch = body.match(/^WEBHOOK_SECRET=(.+)$/m);
  const pemMatch = body.match(/^PRIVATE_KEY="([\s\S]+?)"/m);
  const id = idMatch ? Number(idMatch[1]) : 0;
  const webhook_secret = whMatch?.[1] ?? "";
  const pem = pemMatch?.[1]?.replace(/\\"/g, '"') ?? "";
  return { id, webhook_secret, pem };
}

// Cookie-gated single-use download (D-17, T-08-22 / T-08-24). The first successful GET clears the cookie via Max-Age=0.
export function registerCredentialsDownloadRoute(app: FastifyInstance, deps: DownloadDeps): void {
  app.get("/setup/credentials.env", async (req, reply) => {
    const dl = readDownloadCookie(req);
    if (!dl) {
      return reply.code(401).send({ error: "download_not_authorized" });
    }

    const body = deps.credentials.read();
    if (!body) {
      clearDownloadCookie(reply);
      return reply.code(404).send({ error: "credentials_not_found" });
    }

    clearDownloadCookie(reply);
    deps.log.info({ event: "setup_credentials_downloaded" }, "setup");

    return reply
      .header("Content-Disposition", "attachment; filename=credentials.env")
      .type("application/octet-stream")
      .send(body);
  });
}
