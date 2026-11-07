import { z } from "zod";

export const NOTIFICATION_MODES = ["on", "dry-run", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/** The bot's `getMe` result. grammY needs it to skip a getMe call per update. */
export interface BotInfo {
  id: number;
  is_bot: true;
  first_name: string;
  username: string;
  [key: string]: unknown;
}

export interface AppConfig {
  telegramBotToken: string;
  githubToken: string;
  webhookSecret: string;
  maxReposPerChat: number;
  /** null means every chat may use the bot. */
  allowedChatIds: ReadonlySet<number> | null;
  notifications: NotificationMode;
  /** Where failed-run alerts go. null turns the alerts off. */
  adminChatId: number | null;
  botInfo: BotInfo;
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; errors: string[] };

const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
// Telegram allows 1-256 characters for secret_token; require a strong one.
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const CHAT_ID = /^-?\d{1,16}$/;
const DEFAULT_MAX_REPOS_PER_CHAT = "50";

// Error messages never include the value: some settings are secrets.
function requiredString() {
  return z.string({
    error: (issue) => (issue.input === undefined ? "is required" : "must be text"),
  });
}

function parseChatIdList(value: string | undefined, ctx: z.RefinementCtx): ReadonlySet<number> | null {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  const invalid = parts.filter((part) => !CHAT_ID.test(part));

  if (invalid.length > 0) {
    ctx.addIssue({ code: "custom", message: `has entries that aren't chat IDs: ${invalid.join(", ")}` });
    return z.NEVER;
  }

  return parts.length > 0 ? new Set(parts.map(Number)) : null;
}

function parseOptionalChatId(value: string | undefined, ctx: z.RefinementCtx): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  if (!CHAT_ID.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: "must be a Telegram chat ID (an integer)" });
    return z.NEVER;
  }
  return Number(trimmed);
}

function parseJson(value: string, ctx: z.RefinementCtx): unknown {
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be JSON (the bot's getMe result)" });
    return z.NEVER;
  }
}

const botInfoSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.literal(true),
  first_name: z.string(),
  username: z.string(),
});

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: requiredString().regex(TELEGRAM_TOKEN, "doesn't look like a Telegram bot token"),
  GITHUB_TOKEN: requiredString().regex(/^\S+$/, "must not be empty or contain spaces"),
  WEBHOOK_SECRET: requiredString().regex(
    WEBHOOK_SECRET,
    "must be 32-256 characters of A-Z, a-z, 0-9, _ or -",
  ),
  MAX_REPOS_PER_CHAT: z
    .string()
    .default(DEFAULT_MAX_REPOS_PER_CHAT)
    .pipe(z.string().regex(/^\d+$/, "must be a whole number"))
    .transform(Number)
    .pipe(z.number().int().min(1, "must be at least 1").max(500, "must be at most 500")),
  ALLOWED_CHAT_IDS: z.string().optional().transform(parseChatIdList),
  NOTIFICATIONS: z.enum(NOTIFICATION_MODES, {
    error: (issue) =>
      issue.input === undefined ? "is required: on, dry-run or off" : "must be on, dry-run or off",
  }),
  ADMIN_CHAT_ID: z.string().optional().transform(parseOptionalChatId),
  BOT_INFO: requiredString().transform(parseJson).pipe(botInfoSchema),
});

function formatIssue(issue: z.core.$ZodIssue): string {
  const name = issue.path.length > 0 ? issue.path.join(".") : "settings";
  return `${name} ${issue.message}`;
}

/** Validates the Worker's settings. Never throws. */
export function parseConfig(env: object): ConfigResult {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map(formatIssue) };
  }

  const settings = result.data;
  return {
    ok: true,
    config: {
      telegramBotToken: settings.TELEGRAM_BOT_TOKEN,
      githubToken: settings.GITHUB_TOKEN,
      webhookSecret: settings.WEBHOOK_SECRET,
      maxReposPerChat: settings.MAX_REPOS_PER_CHAT,
      allowedChatIds: settings.ALLOWED_CHAT_IDS,
      notifications: settings.NOTIFICATIONS,
      adminChatId: settings.ADMIN_CHAT_ID,
      botInfo: settings.BOT_INFO,
    },
  };
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
    console.error(JSON.stringify({ message: "Invalid Worker settings", errors: result.errors }));
  }
  cache.set(env, result);
  return result;
}
