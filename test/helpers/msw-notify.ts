// Shared msw harness for Slack/Telegram notification channel tests.
import { type HttpHandler, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export interface SlackCall {
  body: unknown;
}

export interface TelegramCall {
  body: unknown;
}

export interface NotifyHarness {
  server: ReturnType<typeof setupServer>;
  slackCalls: SlackCall[];
  telegramCalls: TelegramCall[];
  reset(): void;
  setSlackResponse(status: number, body?: string, headers?: Record<string, string>): void;
  setTelegramResponse(status: number, json: object): void;
}

export function createNotifyHarness(): NotifyHarness {
  const slackCalls: SlackCall[] = [];
  const telegramCalls: TelegramCall[] = [];

  let slackOverride: HttpHandler | null = null;
  let telegramOverride: HttpHandler | null = null;

  const defaultSlackHandler = http.post(
    "https://hooks.slack.com/services/:rest+",
    async ({ request }) => {
      slackCalls.push({
        body: await request
          .clone()
          .json()
          .catch(() => null),
      });
      return new HttpResponse("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    },
  );

  // Match any bot token — tests inject a known token so this catches all sends.
  const defaultTelegramHandler = http.post(
    "https://api.telegram.org/bot*/sendMessage",
    async ({ request }) => {
      telegramCalls.push({
        body: await request
          .clone()
          .json()
          .catch(() => null),
      });
      return HttpResponse.json({ ok: true, result: { message_id: 1 } });
    },
  );

  const server = setupServer(defaultSlackHandler, defaultTelegramHandler);

  return {
    server,
    slackCalls,
    telegramCalls,
    reset() {
      slackCalls.length = 0;
      telegramCalls.length = 0;
      slackOverride = null;
      telegramOverride = null;
      server.resetHandlers();
    },
    setSlackResponse(status, body = "", headers = {}) {
      slackOverride = http.post("https://hooks.slack.com/services/:rest+", async ({ request }) => {
        slackCalls.push({
          body: await request
            .clone()
            .json()
            .catch(() => null),
        });
        return new HttpResponse(body, {
          status,
          headers: { "Content-Type": "text/plain", ...headers },
        });
      });
      server.use(slackOverride);
    },
    setTelegramResponse(status, json) {
      telegramOverride = http.post(
        "https://api.telegram.org/bot*/sendMessage",
        async ({ request }) => {
          telegramCalls.push({
            body: await request
              .clone()
              .json()
              .catch(() => null),
          });
          return HttpResponse.json(json, { status });
        },
      );
      server.use(telegramOverride);
    },
  };
}
