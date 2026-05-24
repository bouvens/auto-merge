import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import { notifySlackEnv, notifyTelegramEnv } from "../../src/onboarding/envNotify.js";

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/xxx";
const TG_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TG_CHAT = "-100123456";
const TG_URL = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;

interface CapturedRequest {
  url: string;
  body: unknown;
}
const captured: CapturedRequest[] = [];

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  captured.length = 0;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function envBase() {
  return {
    SLACK_WEBHOOK_URL: undefined as string | undefined,
    TELEGRAM_BOT_TOKEN: undefined as string | undefined,
    TELEGRAM_DEFAULT_CHAT_ID: undefined as string | undefined,
    NOTIFY_TIMEOUT_MS: 5000,
  };
}

describe("notifySlackEnv", () => {
  it("no-op when SLACK_WEBHOOK_URL undefined", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await notifySlackEnv({ env: envBase() }, "msg");
    expect(captured).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("posts {text} to webhook URL on happy path", async () => {
    server.use(
      http.post(SLACK_URL, async ({ request }) => {
        captured.push({ url: request.url, body: await request.json() });
        return HttpResponse.text("ok");
      }),
    );
    await notifySlackEnv({ env: { ...envBase(), SLACK_WEBHOOK_URL: SLACK_URL } }, "hello");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(SLACK_URL);
    expect(captured[0]?.body).toEqual({ text: "hello" });
  });

  it("swallows non-2xx response and logs warn with status", async () => {
    server.use(http.post(SLACK_URL, () => new HttpResponse("boom", { status: 500 })));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await expect(
      notifySlackEnv({ env: { ...envBase(), SLACK_WEBHOOK_URL: SLACK_URL } }, "msg"),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall).toMatchObject({
      event: "onboard_envnotify_failed",
      channel: "slack",
      status: 500,
    });
  });

  it("swallows network error and logs warn", async () => {
    server.use(http.post(SLACK_URL, () => HttpResponse.error()));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await expect(
      notifySlackEnv({ env: { ...envBase(), SLACK_WEBHOOK_URL: SLACK_URL } }, "msg"),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.channel).toBe("slack");
    expect(firstCall.event).toBe("onboard_envnotify_failed");
  });
});

describe("notifyTelegramEnv", () => {
  it("no-op when TELEGRAM_BOT_TOKEN undefined", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await notifyTelegramEnv({ env: { ...envBase(), TELEGRAM_DEFAULT_CHAT_ID: TG_CHAT } }, "msg");
    expect(captured).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no-op when TELEGRAM_DEFAULT_CHAT_ID undefined (token set)", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await notifyTelegramEnv({ env: { ...envBase(), TELEGRAM_BOT_TOKEN: TG_TOKEN } }, "msg");
    expect(captured).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("posts {chat_id,text} to bot sendMessage endpoint on happy path", async () => {
    server.use(
      http.post(TG_URL, async ({ request }) => {
        captured.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    await notifyTelegramEnv(
      {
        env: {
          ...envBase(),
          TELEGRAM_BOT_TOKEN: TG_TOKEN,
          TELEGRAM_DEFAULT_CHAT_ID: TG_CHAT,
        },
      },
      "tg hello",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain(`bot${TG_TOKEN}/sendMessage`);
    expect(captured[0]?.body).toEqual({ chat_id: TG_CHAT, text: "tg hello" });
  });

  it("swallows non-2xx telegram response and logs warn", async () => {
    server.use(http.post(TG_URL, () => HttpResponse.json({ ok: false }, { status: 500 })));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await expect(
      notifyTelegramEnv(
        {
          env: {
            ...envBase(),
            TELEGRAM_BOT_TOKEN: TG_TOKEN,
            TELEGRAM_DEFAULT_CHAT_ID: TG_CHAT,
          },
        },
        "msg",
      ),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall).toMatchObject({
      event: "onboard_envnotify_failed",
      channel: "telegram",
      status: 500,
    });
  });
});
