// Worker settings: validated once per isolate into a typed AppConfig.
// Nothing else should read settings from env directly.
//
// Uses zod/mini: the same validation as full zod for about 4% of the bundle
// size (17 KiB instead of 462 KiB minified).
import * as z from "zod/mini";
import { ENVIRONMENTS } from "./environment";
import { err, ok, type Result } from "./result";

export const NOTIFICATION_MODES = ["on", "dry-run", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

const TELEGRAM_TOKEN = /^(\d+):[A-Za-z0-9_-]{30,}$/;
// Telegram allows 1-256 characters for secret_token; require a strong one.
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
// Non-zero integers that fit exactly in a JavaScript number.
const CHAT_ID = /^-?[1-9]\d{0,15}$/;
const DEFAULT_MAX_REPOS_PER_CHAT = 50;

type Issues = z.core.ParsePayload["issues"];

// Error messages never include the value: some settings are secrets.
function addIssue(issues: Issues, input: unknown, message: string): typeof z.NEVER {
  issues.push({ code: "custom", input, message });
  return z.NEVER;
}

function requiredString() {
  return z.string({
    error: (issue) => (issue.input === undefined ? "is required" : "must be text"),
  });
}

function toChatId(value: string): number | null {
  const id = Number(value);
  return CHAT_ID.test(value) && Number.isSafeInteger(id) ? id : null;
}

function parseChatIdList(value: string | undefined, ctx: z.core.ParsePayload): ReadonlySet<number> | null {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  const ids = parts.map(toChatId);
  const invalid = ids.flatMap((id, index) => (id === null ? [index + 1] : []));

  if (invalid.length > 0) {
    return addIssue(ctx.issues, value, `has entries that aren't chat IDs (entry ${invalid.join(", ")})`);
  }
  return ids.length > 0 ? new Set(ids as number[]) : null;
}

function parseOptionalChatId(value: string | undefined, ctx: z.core.ParsePayload): number | null {
  if (value === undefined) {
    return null;
  }
  return toChatId(value) ?? addIssue(ctx.issues, value, "must be a Telegram chat ID (a non-zero integer)");
}

function parseMaxRepos(value: string | undefined, ctx: z.core.ParsePayload): number {
  if (value === undefined) {
    return DEFAULT_MAX_REPOS_PER_CHAT;
  }
  const max = Number(value);
  if (!/^\d+$/.test(value) || max < 1 || max > 500) {
    return addIssue(ctx.issues, value, "must be a whole number from 1 to 500");
  }
  return max;
}

function parseJson(value: string, ctx: z.core.ParsePayload): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return addIssue(ctx.issues, value, "must be JSON (the bot's getMe result)");
  }
}

/** The bot's `getMe` result. grammY needs it to skip a getMe call per update. */
// The fields every getMe result has. Fields added in later Bot API versions
// pass through unchanged.
const botInfoSchema = z.looseObject({
  id: z.number().check(z.int()),
  is_bot: z.literal(true),
  first_name: z.string(),
  username: z.string(),
  can_join_groups: z.boolean(),
  can_read_all_group_messages: z.boolean(),
  supports_inline_queries: z.boolean(),
});

const settingsShape = {
  TELEGRAM_BOT_TOKEN: requiredString().check(z.regex(TELEGRAM_TOKEN, "doesn't look like a Telegram bot token")),
  GITHUB_TOKEN: requiredString().check(z.regex(/^\S+$/, "must not contain spaces")),
  WEBHOOK_SECRET: requiredString().check(
    z.regex(WEBHOOK_SECRET, "must be 32-256 characters of A-Z, a-z, 0-9, _ or -"),
  ),
  NOTIFICATIONS: z.enum(NOTIFICATION_MODES, {
    error: (issue) =>
      issue.input === undefined ? "is required: on, dry-run or off" : "must be on, dry-run or off",
  }),
  BOT_INFO: z.pipe(z.pipe(requiredString(), z.transform(parseJson)), botInfoSchema),
  MAX_REPOS_PER_CHAT: z.pipe(z.optional(z.string()), z.transform(parseMaxRepos)),
  ALLOWED_CHAT_IDS: z.pipe(z.optional(z.string()), z.transform(parseChatIdList)),
  ADMIN_CHAT_ID: z.pipe(z.optional(z.string()), z.transform(parseOptionalChatId)),
  // No default: the staging guard below must fail closed, never fall back to production.
  ENVIRONMENT: z.enum(ENVIRONMENTS, {
    error: (issue) =>
      issue.input === undefined ? "is required: production or staging" : "must be production or staging",
  }),
};

type Settings = z.output<z.ZodMiniObject<typeof settingsShape>>;

// The bot token starts with the bot's ID, so BOT_INFO from another bot is
// caught here instead of breaking command matching later.
function checkBotMatchesToken(settings: Settings, ctx: z.core.$RefinementCtx<Settings>): void {
  const tokenBotId = TELEGRAM_TOKEN.exec(settings.TELEGRAM_BOT_TOKEN)?.[1];
  if (tokenBotId !== String(settings.BOT_INFO.id)) {
    ctx.addIssue({ code: "custom", path: ["BOT_INFO"], message: "is for a different bot than TELEGRAM_BOT_TOKEN" });
  }
}

// Staging holds a copy of production data during the rehearsal: its bot must
// never message anyone outside the allowlist, admin alerts included.
function checkStagingIsRestricted(settings: Settings, ctx: z.core.$RefinementCtx<Settings>): void {
  if (settings.ENVIRONMENT !== "staging") {
    return;
  }
  const allowed = settings.ALLOWED_CHAT_IDS;
  if (allowed === null) {
    ctx.addIssue({ code: "custom", path: ["ALLOWED_CHAT_IDS"], message: "is required in staging" });
  } else if (settings.ADMIN_CHAT_ID !== null && !allowed.has(settings.ADMIN_CHAT_ID)) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_CHAT_ID"], message: "must be in ALLOWED_CHAT_IDS in staging" });
  }
}

function toAppConfig(settings: Settings) {
  return {
    telegramBotToken: settings.TELEGRAM_BOT_TOKEN,
    githubToken: settings.GITHUB_TOKEN,
    webhookSecret: settings.WEBHOOK_SECRET,
    notifications: settings.NOTIFICATIONS,
    /** The bot's getMe result. */
    botInfo: settings.BOT_INFO,
    maxReposPerChat: settings.MAX_REPOS_PER_CHAT,
    /** null means every chat may use the bot. */
    allowedChatIds: settings.ALLOWED_CHAT_IDS,
    /** Where failed-run alerts go. null turns the alerts off. */
    adminChatId: settings.ADMIN_CHAT_ID,
    /** Shown in admin alerts, so a staging alert isn't mistaken for production. */
    environment: settings.ENVIRONMENT,
  };
}

const configSchema = z.pipe(
  z.object(settingsShape).check(z.superRefine(checkBotMatchesToken), z.superRefine(checkStagingIsRestricted)),
  z.transform(toAppConfig),
);

export type AppConfig = z.output<typeof configSchema>;

/** The parsed settings, or one message per invalid setting. */
export type ConfigResult = Result<AppConfig, string[]>;

/**
 * Trims every setting and treats empty ones as unset, so a stray newline in a
 * secret or an empty override doesn't take the Worker down.
 */
function readSettings(env: object): Record<string, unknown> {
  const source = env as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(settingsShape).map((name) => {
      const value = source[name];
      const trimmed = typeof value === "string" ? value.trim() : value;
      return [name, trimmed === "" ? undefined : trimmed];
    }),
  );
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const name = issue.path.length > 0 ? issue.path.join(".") : "settings";
  return `${name} ${issue.message}`;
}

/** Validates the Worker's settings. Never throws. */
export function parseConfig(env: object): ConfigResult {
  const result = z.safeParse(configSchema, readSettings(env));
  return result.success
    ? ok(result.data)
    : err(result.error.issues.map(formatIssue));
}

// Settings don't change while an isolate lives, so parse (and log) once.
const cache = new WeakMap<object, ConfigResult>();

/** parseConfig, cached per env object. Logs invalid settings once. */
export function loadConfig(env: object): ConfigResult {
  const cached = cache.get(env);
  if (cached) {
    return cached;
  }

  const result = parseConfig(env);
  if (!result.ok) {
    console.error(JSON.stringify({ message: "Invalid Worker settings", errors: result.error }));
  }
  cache.set(env, result);
  return result;
}
