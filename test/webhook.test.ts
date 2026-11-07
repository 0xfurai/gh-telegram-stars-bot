import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/http";
import { fakeTelegram, messageUpdate, testConfig, webhookRequest } from "./telegram";

async function deliver(update: unknown, options: { allowed?: string; fail?: boolean; secret?: string | null } = {}) {
  const telegram = fakeTelegram({ fail: options.fail });
  const config = testConfig(options.allowed ? { ALLOWED_CHAT_IDS: options.allowed } : {});
  const response = await handleFetch(webhookRequest(update, options.secret), {
    config,
    telegramFetch: telegram.fetch,
  });
  return { response, calls: telegram.calls };
}

function sentTexts(calls: { method: string; body: Record<string, unknown> }[]): unknown[] {
  return calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhook", () => {
  it("rejects requests without the right secret token, before touching the bot", async () => {
    for (const secret of [null, "wrong-secret-wrong-secret-wrong-secret"]) {
      const { response, calls } = await deliver(messageUpdate("/list"), { secret });

      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
    }
  });

  it("only accepts POST", async () => {
    const response = await handleFetch(new Request("https://bot.test/webhook"), { config: testConfig() });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("runs a known command once", async () => {
    const { response, calls } = await deliver(messageUpdate("/list"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.body.chat_id).toBe(1);
  });

  it("runs /list@ThisBot once, without an 'Unknown command' reply", async () => {
    const { calls } = await deliver(messageUpdate("/list@test_bot"));

    expect(calls).toHaveLength(1);
    expect(sentTexts(calls)[0]).not.toContain("Unknown command");
  });

  it("ignores commands addressed to another bot", async () => {
    const { response, calls } = await deliver(messageUpdate("/list@other_bot"));

    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("answers /address with 'Unknown command' only, instead of running /add", async () => {
    const { calls } = await deliver(messageUpdate("/address"));

    expect(sentTexts(calls)).toEqual(["Unknown command. Type /help to see the available commands."]);
  });

  it("doesn't treat a command later in the text as a command", async () => {
    const update = messageUpdate("see /help for details");
    update.message = {
      ...update.message,
      ...{ entities: [{ type: "bot_command", offset: 4, length: 5 }] },
    };

    const { calls } = await deliver(update);

    expect(calls).toEqual([]);
  });

  it("ignores chats outside ALLOWED_CHAT_IDS and serves the ones inside", async () => {
    const outside = await deliver(messageUpdate("/list", 99), { allowed: "1,2" });
    const inside = await deliver(messageUpdate("/list", 2), { allowed: "1,2" });

    expect(outside.response.status).toBe(200);
    expect(outside.calls).toEqual([]);
    expect(inside.calls).toHaveLength(1);
  });

  it("logs a failed update and still answers 200, so Telegram doesn't redeliver it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { response } = await deliver(messageUpdate("/list"), { fail: true });

    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry.message).toBe("Update failed");
    expect(typeof entry.updateId).toBe("number");
  });
});
