// Test helpers: a fake Telegram Bot API and update builders.
import { parseConfig, type AppConfig } from "../src/config";
import { TEST_SETTINGS } from "./settings";

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

/** A fetch that answers Bot API calls and records them. */
export function fakeTelegram(options: { fail?: boolean } = {}) {
  const calls: TelegramCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });

    if (options.fail) {
      return Promise.resolve(
        Response.json({ ok: false, error_code: 500, description: "Internal Server Error" }, { status: 500 }),
      );
    }
    return Promise.resolve(
      Response.json({ ok: true, result: { message_id: calls.length, date: 0, chat: { id: body.chat_id } } }),
    );
  };
  return { fetch, calls };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const result = parseConfig({ ...TEST_SETTINGS, ...overrides });
  if (!result.ok) {
    throw new Error(`Invalid test settings: ${result.error.join("; ")}`);
  }
  return result.value;
}

let updateId = 1000;

/** A private-chat message update; text starting with "/" gets a command entity. */
export function messageUpdate(text: string, chatId = 1) {
  const firstWord = text.split(/\s/)[0] ?? "";
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "private", first_name: "User" },
      from: { id: chatId, is_bot: false, first_name: "User" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: firstWord.length }] }
        : {}),
    },
  };
}

export function webhookRequest(update: unknown, secret: string | null = TEST_SETTINGS.WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  }
  return new Request("https://bot.test/webhook", { method: "POST", headers, body: JSON.stringify(update) });
}
