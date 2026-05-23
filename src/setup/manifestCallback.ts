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
  const pemTail = escapeHtml(info.pemTail);

  const slugRow = slug
    ? `<dt>Slug</dt><dd><code>${slug}</code></dd>`
    : "";
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
<dt>PRIVATE_KEY</dt><dd><code>${pemTail}</code></dd>
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
