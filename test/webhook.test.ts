import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotDeps } from "../src/bot";
import { handleFetch } from "../src/http";
import * as messages from "../src/messages";
import { TEST_SETTINGS } from "./settings";
import { fakeTelegram, messageUpdate, testConfig, webhookRequest } from "./telegram";

interface DeliverOptions {
  allowed?: string;
  fail?: boolean;
  secret?: string | null;
  commandHandlers?: BotDeps["commandHandlers"];
}

async function deliver(update: unknown, options: DeliverOptions = {}) {
  const telegram = fakeTelegram({ fail: options.fail });
  const config = testConfig(options.allowed ? { ALLOWED_CHAT_IDS: options.allowed } : {});
  const response = await handleFetch(webhookRequest(update, options.secret), {
    config,
    db: env.DB,
    telegramFetch: telegram.fetch,
    commandHandlers: options.commandHandlers,
  });
  return { response, calls: telegram.calls };
}

function sentTexts(calls: { method: string; body: Record<string, unknown> }[]): unknown[] {
  return calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
}

/** Records the arguments of each /add call. */
function recordingAdd() {
  const args: string[] = [];
  const handlers: BotDeps["commandHandlers"] = {
    add: (_ctx, commandArgs) => {
      args.push(commandArgs);
      return Promise.resolve();
    },
  };
  return { args, handlers };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhook: access", () => {
  it("rejects requests without the right secret token, before touching the bot", async () => {
    for (const secret of [null, "wrong-secret-wrong-secret-wrong-secret"]) {
      const { response, calls } = await deliver(messageUpdate("/list"), { secret });

      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
    }
  });

  it("only accepts POST", async () => {
    const response = await handleFetch(new Request("https://bot.test/webhook"), { config: testConfig(), db: env.DB });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("ignores chats outside ALLOWED_CHAT_IDS and serves the ones inside", async () => {
    const outside = await deliver(messageUpdate("/list", 99), { allowed: "1,2" });
    const inside = await deliver(messageUpdate("/list", 2), { allowed: "1,2" });

    expect(outside.response.status).toBe(200);
    expect(outside.calls).toEqual([]);
    expect(inside.calls).toHaveLength(1);
  });
});

describe("POST /webhook: commands", () => {
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

  it("matches commands and the bot name case-insensitively", async () => {
    const add = recordingAdd();

    await deliver(messageUpdate("/ADD@Test_Bot owner/repo"), { commandHandlers: add.handlers });

    expect(add.args).toEqual(["owner/repo"]);
  });

  it("passes the text after the command, trimmed", async () => {
    const add = recordingAdd();

    await deliver(messageUpdate("/add   https://github.com/facebook/react  "), { commandHandlers: add.handlers });
    await deliver(messageUpdate("/add"), { commandHandlers: add.handlers });

    expect(add.args).toEqual(["https://github.com/facebook/react", ""]);
  });

  it("finds the command when a formatting entity comes first", async () => {
    const add = recordingAdd();
    const update = messageUpdate("/add owner/repo");
    update.message = {
      ...update.message,
      ...{
        entities: [
          { type: "bold", offset: 0, length: 4 },
          { type: "bot_command", offset: 0, length: 4 },
        ],
      },
    };

    await deliver(update, { commandHandlers: add.handlers });

    expect(add.args).toEqual(["owner/repo"]);
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
    update.message = { ...update.message, ...{ entities: [{ type: "bot_command", offset: 4, length: 5 }] } };

    const { calls } = await deliver(update);

    // Plain text in a private chat gets the hint, not /help.
    expect(sentTexts(calls)).toEqual([messages.plainTextHint()]);
  });
});

describe("bot cache", () => {
  it("reuses the bot for the same deps and rebuilds it when one differs", async () => {
    const config = testConfig();
    const telegram = fakeTelegram();
    const calls: string[] = [];
    const handlersFor = (name: string): BotDeps["commandHandlers"] => ({
      add: () => {
        calls.push(name);
        return Promise.resolve();
      },
    });
    const first = handlersFor("first");
    const second = handlersFor("second");

    for (const commandHandlers of [first, first, second]) {
      await handleFetch(webhookRequest(messageUpdate("/add x")), {
        config,
        db: env.DB,
        telegramFetch: telegram.fetch,
        commandHandlers,
      });
    }

    expect(calls).toEqual(["first", "first", "second"]);
  });
});

describe("POST /webhook: failures answer 200, so Telegram doesn't redeliver", () => {
  it("logs a reply Telegram refused, as a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { response } = await deliver(messageUpdate("/list"), { fail: true });

    expect(response.status).toBe(200);
    const entry = JSON.parse(String(warn.mock.calls[0]?.[0])) as { message: string; error: { kind: string } };
    expect(entry.message).toBe("Reply not sent");
    expect(entry.error.kind).toBe("unavailable");
  });

  it("logs a handler that throws, with the update ID", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { response } = await deliver(messageUpdate("/add x"), {
      commandHandlers: { add: () => Promise.reject(new Error("boom")) },
    });

    expect(response.status).toBe(200);
    const entry = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({ message: "Update failed", error: "boom" });
    expect(typeof entry.updateId).toBe("number");
  });

  it("logs a request body that isn't JSON", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": TEST_SETTINGS.WEBHOOK_SECRET },
      body: "{not json",
    });

    const response = await handleFetch(request, {
      config: testConfig(),
      db: env.DB,
      telegramFetch: fakeTelegram().fetch,
    });

    expect(response.status).toBe(200);
    expect(String(error.mock.calls[0]?.[0])).toContain("Webhook request failed");
  });
});

describe("POST /webhook: membership changes", () => {
  const user = { id: 7, is_bot: false, first_name: "User" };
  const bot = { id: 123456789, is_bot: true, first_name: "Test bot", username: "test_bot" };
  let nextUpdateId = 5000;

  function membership(chatId: number, status: "member" | "kicked" | "left" | "administrator") {
    return {
      update_id: ++nextUpdateId,
      my_chat_member: {
        chat: chatId > 0 ? { id: chatId, type: "private", first_name: "User" } : { id: chatId, type: "group", title: "G" },
        from: user,
        date: 1_700_000_000,
        old_chat_member: { status: "member", user: bot },
        new_chat_member: status === "kicked" ? { status, user: bot, until_date: 0 } : { status, user: bot },
      },
    };
  }

  async function isActive(chatId: number) {
    return env.DB.prepare("SELECT is_active FROM chats WHERE id = ?").bind(chatId).first<number>("is_active");
  }

  it("deactivates a chat when the user blocks the bot, and reactivates it when they unblock", async () => {
    await env.DB.prepare("INSERT INTO chats (id) VALUES (31) ON CONFLICT DO NOTHING").run();

    await deliver(membership(31, "kicked"));
    expect(await isActive(31)).toBe(0);

    await deliver(membership(31, "member"));
    expect(await isActive(31)).toBe(1);
  });

  it("tracks being removed from and added back to a group", async () => {
    await deliver(membership(-32, "left"));
    expect(await isActive(-32)).toBe(0);

    await deliver(membership(-32, "administrator"));
    expect(await isActive(-32)).toBe(1);
  });

  it("moves a group's subscriptions when it becomes a supergroup", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO chats (id) VALUES (-33)"),
      env.DB.prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (330, 'R_330', 'o/r', 5)"),
      env.DB.prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (-33, 330, 5)"),
    ]);

    await deliver({
      update_id: ++nextUpdateId,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -33, type: "group", title: "G" },
        from: user,
        migrate_to_chat_id: -100333,
      },
    });

    const moved = await env.DB.prepare("SELECT chat_id FROM chat_repositories WHERE repository_id = 330").all();
    expect(moved.results).toEqual([{ chat_id: -100333 }]);
    expect(await isActive(-100333)).toBe(1);
    expect(await isActive(-33)).toBe(0);
  });
});
