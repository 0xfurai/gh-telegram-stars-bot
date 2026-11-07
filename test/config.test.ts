import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseConfig, type ConfigResult } from "../src/config";
import worker from "../src/index";
import { TEST_SETTINGS } from "./settings";

function parse(overrides: Record<string, string | undefined> = {}): ConfigResult {
  return parseConfig({ ...TEST_SETTINGS, ...overrides });
}

function errorsOf(result: ConfigResult): string[] {
  return result.ok ? [] : result.errors;
}

describe("parseConfig", () => {
  it("accepts valid settings and fills in defaults", () => {
    const result = parse();

    expect(result).toEqual({
      ok: true,
      config: {
        telegramBotToken: TEST_SETTINGS.TELEGRAM_BOT_TOKEN,
        githubToken: TEST_SETTINGS.GITHUB_TOKEN,
        webhookSecret: TEST_SETTINGS.WEBHOOK_SECRET,
        maxReposPerChat: 50,
        allowedChatIds: null,
        notifications: "dry-run",
        adminChatId: null,
        botInfo: { id: 123456789, is_bot: true, first_name: "Test bot", username: "test_bot" },
      },
    });
  });

  it.each(["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "WEBHOOK_SECRET", "BOT_INFO"])(
    "rejects a missing %s",
    (name) => {
      expect(errorsOf(parse({ [name]: undefined }))).toEqual([`${name} is required`]);
    },
  );

  it("requires NOTIFICATIONS, with no default", () => {
    expect(errorsOf(parse({ NOTIFICATIONS: undefined }))).toEqual([
      "NOTIFICATIONS is required: on, dry-run or off",
    ]);
    expect(errorsOf(parse({ NOTIFICATIONS: "yes" }))).toEqual([
      "NOTIFICATIONS must be on, dry-run or off",
    ]);
  });

  it("parses ALLOWED_CHAT_IDS, ignoring spaces and empty entries", () => {
    const result = parse({ ALLOWED_CHAT_IDS: " 42, -1001234567890 ,," });

    expect(result.ok && [...(result.config.allowedChatIds ?? [])]).toEqual([42, -1001234567890]);
  });

  it("treats an empty ALLOWED_CHAT_IDS as no restriction", () => {
    const result = parse({ ALLOWED_CHAT_IDS: "  " });

    expect(result.ok && result.config.allowedChatIds).toBeNull();
  });

  it("rejects ALLOWED_CHAT_IDS entries that aren't chat IDs, instead of turning them into NaN", () => {
    expect(errorsOf(parse({ ALLOWED_CHAT_IDS: "42,abc,4 2" }))).toEqual([
      "ALLOWED_CHAT_IDS has entries that aren't chat IDs: abc, 4 2",
    ]);
  });

  it("parses an optional ADMIN_CHAT_ID", () => {
    const result = parse({ ADMIN_CHAT_ID: "-1001234567890" });

    expect(result.ok && result.config.adminChatId).toBe(-1001234567890);
    expect(errorsOf(parse({ ADMIN_CHAT_ID: "me" }))).toEqual([
      "ADMIN_CHAT_ID must be a Telegram chat ID (an integer)",
    ]);
  });

  it("validates MAX_REPOS_PER_CHAT", () => {
    const result = parse({ MAX_REPOS_PER_CHAT: "10" });

    expect(result.ok && result.config.maxReposPerChat).toBe(10);
    expect(errorsOf(parse({ MAX_REPOS_PER_CHAT: "ten" }))).toEqual([
      "MAX_REPOS_PER_CHAT must be a whole number",
    ]);
    expect(errorsOf(parse({ MAX_REPOS_PER_CHAT: "0" }))).toEqual([
      "MAX_REPOS_PER_CHAT must be at least 1",
    ]);
  });

  it("requires a strong WEBHOOK_SECRET", () => {
    expect(errorsOf(parse({ WEBHOOK_SECRET: "short" }))).toEqual([
      "WEBHOOK_SECRET must be 32-256 characters of A-Z, a-z, 0-9, _ or -",
    ]);
  });

  it("rejects BOT_INFO that isn't JSON or isn't a bot", () => {
    expect(errorsOf(parse({ BOT_INFO: "{not json" }))).toEqual([
      "BOT_INFO must be JSON (the bot's getMe result)",
    ]);
    expect(errorsOf(parse({ BOT_INFO: JSON.stringify({ id: 1, is_bot: false }) }))).toHaveLength(3);
  });

  it("reports every invalid setting at once", () => {
    expect(errorsOf(parse({ GITHUB_TOKEN: undefined, NOTIFICATIONS: undefined }))).toHaveLength(2);
  });

  it("never puts setting values in error messages", () => {
    const secret = "123456789:SECRET-value-must-not-leak-into-logs!!";
    const errors = errorsOf(parse({ TELEGRAM_BOT_TOKEN: secret, WEBHOOK_SECRET: "leaky secret value" }));

    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).not.toContain("SECRET-value");
    expect(errors.join(" ")).not.toContain("leaky secret value");
  });
});

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses each env object once and logs invalid settings once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { ...TEST_SETTINGS, NOTIFICATIONS: undefined };

    const first = loadConfig(env);
    const second = loadConfig(env);

    expect(second).toBe(first);
    expect(first.ok).toBe(false);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("Worker with invalid settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const badEnv = { ...TEST_SETTINGS, WEBHOOK_SECRET: undefined } as unknown as Env;

  it("answers every request with 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = worker.fetch(new Request("https://bot.test/health"), badEnv);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service misconfigured" });
  });

  it("fails the scheduled run instead of skipping it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined };

    expect(() => worker.scheduled(controller, badEnv)).toThrow(
      "Invalid Worker settings: WEBHOOK_SECRET is required",
    );
  });
});
