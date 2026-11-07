import { afterEach, describe, expect, it, vi } from "vitest";
import devVarsExample from "../.dev.vars.example?raw";
import { loadConfig, parseConfig, type ConfigResult } from "../src/config";
import worker from "../src/index";
import { TEST_SETTINGS } from "./settings";

function parse(overrides: Record<string, string | undefined> = {}): ConfigResult {
  return parseConfig({ ...TEST_SETTINGS, ...overrides });
}

function errorsOf(result: ConfigResult): string[] {
  return result.ok ? [] : result.errors;
}

function botInfo(id: number): string {
  return JSON.stringify({ id, is_bot: true, first_name: "Test bot", username: "test_bot" });
}

describe("parseConfig", () => {
  it("accepts valid settings and fills in defaults", () => {
    expect(parse()).toEqual({
      ok: true,
      config: {
        telegramBotToken: TEST_SETTINGS.TELEGRAM_BOT_TOKEN,
        githubToken: TEST_SETTINGS.GITHUB_TOKEN,
        webhookSecret: TEST_SETTINGS.WEBHOOK_SECRET,
        notifications: "dry-run",
        botInfo: { id: 123456789, is_bot: true, first_name: "Test bot", username: "test_bot" },
        maxReposPerChat: 50,
        allowedChatIds: null,
        adminChatId: null,
      },
    });
  });

  it.each(["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "WEBHOOK_SECRET", "BOT_INFO"])(
    "rejects a missing or empty %s",
    (name) => {
      expect(errorsOf(parse({ [name]: undefined }))).toEqual([`${name} is required`]);
      expect(errorsOf(parse({ [name]: "  " }))).toEqual([`${name} is required`]);
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

  it("trims values, so a trailing newline in a secret doesn't break it", () => {
    const result = parse({
      TELEGRAM_BOT_TOKEN: `${TEST_SETTINGS.TELEGRAM_BOT_TOKEN}\r\n`,
      NOTIFICATIONS: " on ",
      MAX_REPOS_PER_CHAT: " 10\n",
    });

    expect(result.ok && result.config.telegramBotToken).toBe(TEST_SETTINGS.TELEGRAM_BOT_TOKEN);
    expect(result.ok && result.config.notifications).toBe("on");
    expect(result.ok && result.config.maxReposPerChat).toBe(10);
  });

  it("parses ALLOWED_CHAT_IDS, ignoring spaces and empty entries", () => {
    const result = parse({ ALLOWED_CHAT_IDS: " 42, -1001234567890 ,," });

    expect(result.ok && [...(result.config.allowedChatIds ?? [])]).toEqual([42, -1001234567890]);
  });

  it("treats an empty ALLOWED_CHAT_IDS as no restriction", () => {
    expect(parse({ ALLOWED_CHAT_IDS: "" }).ok && parse({ ALLOWED_CHAT_IDS: "" })).toMatchObject({
      config: { allowedChatIds: null },
    });
  });

  it("rejects bad ALLOWED_CHAT_IDS entries by position, without echoing them", () => {
    const errors = errorsOf(parse({ ALLOWED_CHAT_IDS: "42,abc,4 2" }));

    expect(errors).toEqual(["ALLOWED_CHAT_IDS has entries that aren't chat IDs (entry 2, 3)"]);
  });

  it.each(["0", "-0", "9999999999999999", "1.5", "me"])("rejects %s as a chat ID", (value) => {
    expect(errorsOf(parse({ ADMIN_CHAT_ID: value }))).toEqual([
      "ADMIN_CHAT_ID must be a Telegram chat ID (a non-zero integer)",
    ]);
    expect(errorsOf(parse({ ALLOWED_CHAT_IDS: value }))).toHaveLength(1);
  });

  it("parses an optional ADMIN_CHAT_ID", () => {
    const result = parse({ ADMIN_CHAT_ID: "-1001234567890" });

    expect(result.ok && result.config.adminChatId).toBe(-1001234567890);
  });

  it("validates MAX_REPOS_PER_CHAT, defaulting when empty", () => {
    expect(parse({ MAX_REPOS_PER_CHAT: "" }).ok && parse({ MAX_REPOS_PER_CHAT: "" })).toMatchObject({
      config: { maxReposPerChat: 50 },
    });
    for (const value of ["ten", "0", "501", "-5"]) {
      expect(errorsOf(parse({ MAX_REPOS_PER_CHAT: value }))).toEqual([
        "MAX_REPOS_PER_CHAT must be a whole number from 1 to 500",
      ]);
    }
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
    expect(errorsOf(parse({ BOT_INFO: JSON.stringify({ id: 123456789, is_bot: false }) }))).toHaveLength(3);
  });

  it("rejects BOT_INFO for a different bot than the token", () => {
    expect(errorsOf(parse({ BOT_INFO: botInfo(987654321) }))).toEqual([
      "BOT_INFO is for a different bot than TELEGRAM_BOT_TOKEN",
    ]);
  });

  it("reports every invalid setting at once", () => {
    expect(errorsOf(parse({ GITHUB_TOKEN: undefined, NOTIFICATIONS: undefined }))).toHaveLength(2);
  });

  it("never puts setting values in error messages", () => {
    const secret = "123456789:SECRET-value-must-not-leak";
    const errors = errorsOf(
      parse({
        TELEGRAM_BOT_TOKEN: secret,
        WEBHOOK_SECRET: "leaky secret value",
        ALLOWED_CHAT_IDS: "42,leaked-token-in-wrong-field",
      }),
    );

    expect(errors).toHaveLength(3);
    for (const leaked of ["SECRET-value", "leaky secret value", "leaked-token"]) {
      expect(errors.join(" ")).not.toContain(leaked);
    }
  });
});

describe(".dev.vars.example", () => {
  it("doesn't pass validation until its placeholders are replaced", () => {
    const settings = Object.fromEntries(
      devVarsExample
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

    expect(Object.keys(settings)).toContain("TELEGRAM_BOT_TOKEN");
    expect(errorsOf(parseConfig(settings))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^TELEGRAM_BOT_TOKEN/),
        expect.stringMatching(/^WEBHOOK_SECRET/),
        expect.stringMatching(/^BOT_INFO/),
      ]),
    );
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
