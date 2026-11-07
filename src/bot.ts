import { Bot, type BotError, type MiddlewareFn } from "grammy";
import type { MessageEntity, UserFromGetMe } from "grammy/types";
import { COMMANDS, type CommandName } from "./command-list";
import { createCommandHandlers, handlePlainText, type CommandHandler } from "./commands";
import type { AppConfig } from "./config";
import { ensureChat } from "./db";
import * as messages from "./messages";
import { replyHtml } from "./telegram";

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

function startsWithCommand(entities: MessageEntity[] | undefined): boolean {
  return entities?.some((e) => e.type === "bot_command" && e.offset === 0) ?? false;
}

function dispatcher(handlers: Record<CommandName, CommandHandler>): MiddlewareFn {
  return async (ctx) => {
    const message = ctx.message;
    if (message?.text === undefined) {
      return;
    }
    const command = parseCommand(message, ctx.me.username);
    if (command === null) {
      // A command for another bot isn't plain text: ignore it.
      return startsWithCommand(message.entities) ? undefined : handlePlainText(ctx, message.text, handlers);
    }
    if (isCommandName(command.name)) {
      return handlers[command.name](ctx, command.args);
    }
    return replyHtml(ctx, messages.unknownCommand());
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

/** A message from a chat means the bot can reach it: create or reactivate it. */
function trackChat(db: D1Database): MiddlewareFn {
  return async (ctx, next) => {
    if (ctx.chat !== undefined) {
      await ensureChat(db, ctx.chat.id);
    }
    await next();
  };
}

function logUpdateError(error: BotError): void {
  console.error(
    JSON.stringify({
      message: "Update failed",
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    }),
  );
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

  // One failed update must never affect others: log it and answer 200, so
  // Telegram doesn't redeliver it. (bot.catch only applies to long polling;
  // with webhooks, errors need an error boundary around the handlers.)
  const guarded = bot.errorBoundary(logUpdateError);
  guarded.use(allowedChatsOnly(config.allowedChatIds));
  guarded.on("message:text", trackChat(deps.db), dispatcher(handlers));
  return bot;
}
