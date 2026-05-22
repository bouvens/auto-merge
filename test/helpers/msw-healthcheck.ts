import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export interface HealthCheckHarness {
  server: ReturnType<typeof setupServer>;
  setSlack(status: number, delay?: number): void;
  setTelegram(status: number, body: object, delay?: number): void;
  slackCalls(): number;
  telegramCalls(): number;
  reset(): void;
}

const DEFAULT_TELEGRAM_BODY: object = { ok: true, result: { id: 1, is_bot: true } };

export function createHealthCheckHarness(): HealthCheckHarness {
  let slackStatus = 200;
  let slackDelay = 0;
  let slackHits = 0;
  let tgStatus = 200;
  let tgBody: object = DEFAULT_TELEGRAM_BODY;
  let tgDelay = 0;
  let tgHits = 0;

  const server = setupServer(
    http.get("https://hooks.slack.com/services/*", async () => {
      slackHits++;
      if (slackDelay) await new Promise((r) => setTimeout(r, slackDelay));
      return new HttpResponse("", { status: slackStatus });
    }),
    http.get("https://api.telegram.org/bot*/getMe", async () => {
      tgHits++;
      if (tgDelay) await new Promise((r) => setTimeout(r, tgDelay));
      return HttpResponse.json(tgBody, { status: tgStatus });
    }),
  );

  return {
    server,
    setSlack(status, delay = 0) {
      slackStatus = status;
      slackDelay = delay;
    },
    setTelegram(status, body, delay = 0) {
      tgStatus = status;
      tgBody = body;
      tgDelay = delay;
    },
    slackCalls: () => slackHits,
    telegramCalls: () => tgHits,
    reset() {
      slackHits = 0;
      tgHits = 0;
      slackStatus = 200;
      tgStatus = 200;
      slackDelay = 0;
      tgDelay = 0;
      tgBody = DEFAULT_TELEGRAM_BODY;
    },
  };
}
