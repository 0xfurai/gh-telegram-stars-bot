import { Bot, type BotError, type Context, type MiddlewareFn } from "grammy";
import type { MessageEntity, UserFromGetMe } from "grammy/types";
import { ADMIN_COMMANDS, COMMANDS, type CommandName } from "./command-list";
import { createCommandHandlers, handlePlainText, type CommandHandler } from "./commands";
import type { AppConfig } from "./config";
import { ensureChat, markChatReachable, migrateChat, setChatActive } from "./db";
import { assertNever } from "./result";
import * as messages from "./messages";
import { hasReplied, replyHtml } from "./telegram";
import { errorMessage } from "./errors";

export type { CommandHandler } from "./commands";

export interface BotDeps {
  db: D1Database;
  /** Replaces fetch for Telegram API calls. */
  telegramFetch?: typeof fetch;
  /** Replaces fetch for GitHub API calls. */
  githubFetch?: typeof fetch;
  /** Replaces individual command handlers. */
  commandHandlers?: Partial<Record<CommandName, CommandHandler>>;
  /** The current time (tests). */
  now?: () => Date;
}

export interface ParsedCommand {
  /** Lowercased, without the @BotName suffix. */
  name: string;
  args: string;
}

/**
 * The command a message starts with, if it's meant for this bot: `/cmd` or
 * `/cmd@ThisBot`, matched case-insensitively. Null for plain text, for a
 * command later in the text ("see /help"), and for `/cmd@OtherBot` in groups.
 */
export function parseCommand(
  message: { text?: string; entities?: MessageEntity[] },
  botUsername: string,
): ParsedCommand | null {
  const entity = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (entity === undefined || message.text === undefined) {
    return null;
  }
  const [name = "", target] = message.text.slice(1, entity.length).split("@");
  if (target !== undefined && target.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }
  return { name: name.toLowerCase(), args: message.text.slice(entity.length).trim() };
}

function isCommandName(name: string): name is CommandName {
  return COMMANDS.some((command) => command.command === name);
}

function isAdminCommand(name: CommandName): boolean {
  return ADMIN_COMMANDS.some((command) => command.command === name);
}

/**
 * The handler for a command in this chat, or null for an unknown command.
 * Admin commands count as unknown outside ADMIN_CHAT_ID, so nothing hints
 * that they exist; with no admin chat, they're unknown everywhere.
 */
function handlerFor(
  name: string,
  chatId: number | undefined,
  handlers: Record<CommandName, CommandHandler>,
  adminChatId: number | null,
): CommandHandler | null {
  if (!isCommandName(name)) {
    return null;
  }
  const allowed = !isAdminCommand(name) || (adminChatId !== null && chatId === adminChatId);
  return allowed ? handlers[name] : null;
}

function startsWithCommand(entities: MessageEntity[] | undefined): boolean {
  return entities?.some((e) => e.type === "bot_command" && e.offset === 0) ?? false;
}

type Action = () => Promise<void>;

/**
 * What a message asks the bot to do, or null when it's not for the bot:
 * group chatter, or a command for another bot.
 */
function actionFor(
  ctx: Context,
  text: string,
  handlers: Record<CommandName, CommandHandler>,
  adminChatId: number | null,
): Action | null {
  const message = ctx.message;
  const command = message ? parseCommand(message, ctx.me.username) : null;
  if (command !== null) {
    const handler = handlerFor(command.name, ctx.chat?.id, handlers, adminChatId);
    return handler ? () => handler(ctx, command.args) : () => replyHtml(ctx, messages.unknownCommand());
  }
  if (startsWithCommand(message?.entities) || ctx.chat?.type !== "private") {
    return null;
  }
  return () => handlePlainText(ctx, text, handlers);
}

/**
 * A message the bot acts on means it can reach the chat: create or reactivate
 * it. If D1 is down, log it and still answer.
 */
async function trackChat(db: D1Database, chatId: number): Promise<void> {
  try {
    await ensureChat(db, chatId);
  } catch (error) {
    console.error(
      JSON.stringify({ message: "Chat not tracked", chatId, error: errorMessage(error) }),
    );
  }
}

function dispatcher(
  db: D1Database,
  handlers: Record<CommandName, CommandHandler>,
  adminChatId: number | null,
): MiddlewareFn {
  return async (ctx) => {
    const text = ctx.message?.text;
    const action = text === undefined ? null : actionFor(ctx, text, handlers, adminChatId);
    if (action === null || ctx.chat === undefined) {
      return;
    }
    await trackChat(db, ctx.chat.id);
    await action();
  };
}

/** Ignores every update from chats outside ALLOWED_CHAT_IDS, when it's set. */
function allowedChatsOnly(allowed: ReadonlySet<number> | null): MiddlewareFn {
  return async (ctx, next) => {
    if (allowed === null || (ctx.chat !== undefined && allowed.has(ctx.chat.id))) {
      await next();
    }
  };
}

type MemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

/**
 * Telegram tells the bot when its own membership changes (my_chat_member):
 * a user blocked or unblocked it, or it was added to or removed from a group.
 * That keeps is_active right even when nobody sends a message.
 */
async function onMembershipChange(db: D1Database, chatId: number, status: MemberStatus): Promise<void> {
  switch (status) {
    case "creator":
    case "administrator":
    case "member":
    case "restricted":
      return markChatReachable(db, chatId);
    case "left":
    case "kicked":
      return setChatActive(db, chatId, false);
    default:
      return assertNever(status);
  }
}

/**
 * Logs a failed update (a D1 outage, a bug) and tells the user, so a command
 * never goes unanswered. No error reply when the handler already answered
 * (the user has a reply; an error after it would contradict it), or for
 * membership updates (nobody to answer). replyHtml logs a refused reply;
 * anything else it throws reaches handleWebhook, which logs it and still
 * answers 200.
 */
async function onUpdateError(error: BotError): Promise<void> {
  console.error(
    JSON.stringify({
      message: "Update failed",
      updateId: error.ctx.update.update_id,
      error: errorMessage(error.error),
    }),
  );
  if (error.ctx.message?.text !== undefined && !hasReplied(error.ctx)) {
    await replyHtml(error.ctx, messages.somethingWentWrong());
  }
}

export function createBot(config: AppConfig, deps: BotDeps): Bot {
  const bot = new Bot(config.telegramBotToken, {
    // Validated in config.ts; getMe fields added in later Bot API versions
    // pass through unchanged.
    botInfo: config.botInfo as unknown as UserFromGetMe,
    client: deps.telegramFetch ? { fetch: deps.telegramFetch } : {},
  });

  const handlers = {
    ...createCommandHandlers({
      config,
      db: deps.db,
      github: { token: config.githubToken, fetch: deps.githubFetch },
      now: deps.now,
    }),
    ...deps.commandHandlers,
  };

  // One failed update must never affect others: log it, tell the user, and
  // answer 200, so Telegram doesn't redeliver it. (bot.catch only applies to long polling;
  // with webhooks, errors need an error boundary around the handlers.)
  const guarded = bot.errorBoundary(onUpdateError);
  guarded.use(allowedChatsOnly(config.allowedChatIds));
  guarded.on("my_chat_member", (ctx) =>
    onMembershipChange(deps.db, ctx.myChatMember.chat.id, ctx.myChatMember.new_chat_member.status),
  );
  // A group became a supergroup: Telegram posts this in the old group.
  guarded.on("message:migrate_to_chat_id", (ctx) =>
    migrateChat(deps.db, ctx.chat.id, ctx.message.migrate_to_chat_id),
  );
  guarded.on("message:text", dispatcher(deps.db, handlers, config.adminChatId));
  return bot;
}
