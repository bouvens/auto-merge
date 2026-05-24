import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { z } from "zod";
import type { Env } from "../env.js";
import type { CredentialsStore } from "./credentials.js";
import { setStateCookie } from "./csrf.js";
import { escapeHtml, jsonForHtmlAttr } from "./html.js";
import { buildManifest } from "./manifestSchema.js";

type ManifestEnv = Pick<Env, "SETUP_APP_NAME" | "SETUP_PUBLIC_URL">;
type WarningEnv = Pick<Env, "SETUP_APP_NAME">;

const INLINE_CSS = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  ol li { margin: 0.4rem 0; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.3em; border-radius: 3px; }
  .warn { border-left: 4px solid #d97706; padding: 0.5rem 1rem; background: rgba(217,119,6,0.08); }
  input[type=text] { width: 100%; padding: 0.5rem; font: inherit; }
  button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
`;

// Org regex per D-10 + Pitfall 7: GitHub username/org rules, blocks ../ traversal.
const ORG_SCHEMA = z.string().regex(/^[a-zA-Z0-9-]{1,39}$/);

export function renderManifestForm(env: ManifestEnv, state: string, org?: string): string {
  const formAction = org
    ? `https://github.com/organizations/${escapeHtml(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const manifestAttr = jsonForHtmlAttr(buildManifest(env, state, org));
  const appName = escapeHtml(env.SETUP_APP_NAME);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${appName} — setup</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<h1>Регистрация ${appName} в GitHub</h1>
<p>Сейчас вы будете перенаправлены на github.com для подтверждения создания GitHub App.</p>
<form action="${formAction}" method="post">
<input type="hidden" name="manifest" value="${manifestAttr}">
<noscript><button type="submit">Продолжить</button></noscript>
</form>
<script>document.querySelector('form').submit();</script>
</body>
</html>`;
}

export function renderWarningPage(env: WarningEnv, existingPath: string): string {
  const appName = escapeHtml(env.SETUP_APP_NAME);
  const path = escapeHtml(existingPath);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${appName} — App уже сконфигурирован</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<div class="warn">
<h1>App уже сконфигурирован</h1>
<p>На диске уже существует файл credentials: <code>${path}</code>. Повторный setup создаст дубликат GitHub App.</p>
</div>
<h2>Восстановление</h2>
<ol>
<li>Откройте <code>github.com/settings/apps</code> и удалите существующий App вручную.</li>
<li>Удалите файл <code>${path}</code> с диска инстанса.</li>
<li>Перезагрузите эту страницу — guard пропустит на форму манифеста.</li>
<li>Если App был только что создан и вы хотите перезаписать credentials — используйте override ниже.</li>
</ol>
<h2>Override (перезаписать credentials)</h2>
<p>Введите имя App'а (<code>${appName}</code>) для подтверждения. Старый файл будет перезаписан после нового callback.</p>
<form method="get" action="/setup/new">
<input type="hidden" name="force" value="1">
<label>Имя App: <input type="text" name="confirm" autocomplete="off" required></label>
<button type="submit">Подтвердить override</button>
</form>
</body>
</html>`;
}

interface ManifestFormDeps {
  env: Env;
  log: pino.Logger;
  credentials: CredentialsStore;
}

interface ManifestFormQuery {
  org?: string;
  force?: string;
  confirm?: string;
}

const HTML_HEADERS = {
  contentType: "text/html; charset=utf-8",
  cacheControl: "no-store, must-revalidate",
} as const;

export function registerManifestFormRoute(app: FastifyInstance, deps: ManifestFormDeps): void {
  app.get("/setup/new", async (req, reply) => {
    const query = (req.query ?? {}) as ManifestFormQuery;

    let org: string | undefined;
    if (query.org !== undefined) {
      const parsed = ORG_SCHEMA.safeParse(query.org);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_org" });
      }
      org = parsed.data;
    }

    if (deps.credentials.exists()) {
      const forceOk = query.force === "1" && query.confirm === deps.env.SETUP_APP_NAME;
      if (!forceOk) {
        return reply
          .type(HTML_HEADERS.contentType)
          .header("Cache-Control", HTML_HEADERS.cacheControl)
          .send(renderWarningPage(deps.env, deps.credentials.getPath()));
      }
      deps.log.warn(
        { event: "setup_overwrite", previous_path: deps.credentials.getPath() },
        "setup",
      );
    }

    const state = randomUUID();
    setStateCookie(reply, deps.env, state);
    deps.log.info({ event: "setup_started", has_org: Boolean(org) }, "setup");

    return reply
      .type(HTML_HEADERS.contentType)
      .header("Cache-Control", HTML_HEADERS.cacheControl)
      .send(renderManifestForm(deps.env, state, org));
  });
}
