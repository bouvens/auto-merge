import { describe, expect, it } from "vitest";

function makeLogger() {
  const lines: string[] = [];
  return import("../../src/log.js").then(({ initLogger }) => {
    const logger = initLogger(
      { LOG_LEVEL: "trace", NODE_ENV: "test" },
      { write: (line: string) => lines.push(line) },
    );
    return { logger, lines };
  });
}

describe("pino redact", () => {
  it("redacts privateKey field containing PEM header", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ privateKey: "-----BEGIN RSA PRIVATE KEY-----\nXXX" }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(out["privateKey"]).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("BEGIN");
  });

  it("redacts nested token via wildcard *.token", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ obj: { token: "secret-xyz" } }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as { obj: { token: unknown } };
    expect(out.obj.token).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("secret-xyz");
  });

  it("redacts bot_token at root level", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ bot_token: "abc123" }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(out["bot_token"]).toBe("[REDACTED]");
  });

  it("redacts webhook_url at root level", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ webhook_url: "https://hooks.slack.com/services/XXX" }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(out["webhook_url"]).toBe("[REDACTED]");
  });

  it("redacts x-hub-signature-256 and authorization headers", async () => {
    const { logger, lines } = await makeLogger();
    logger.info(
      { headers: { "x-hub-signature-256": "sha256=abc", authorization: "Bearer xyz" } },
      "msg",
    );
    const out = JSON.parse(lines[0] ?? "{}") as { headers: Record<string, unknown> };
    expect(out.headers["x-hub-signature-256"]).toBe("[REDACTED]");
    expect(out.headers["authorization"]).toBe("[REDACTED]");
  });

  it("does not redact ordinary metadata fields", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ delivery_id: "123", event: "push", repo: "owner/repo" }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(out["delivery_id"]).toBe("123");
    expect(out["event"]).toBe("push");
    expect(out["repo"]).toBe("owner/repo");
  });

  it("redacts private_key snake_case variant", async () => {
    const { logger, lines } = await makeLogger();
    logger.info({ private_key: "supersecret" }, "msg");
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(out["private_key"]).toBe("[REDACTED]");
  });
});
