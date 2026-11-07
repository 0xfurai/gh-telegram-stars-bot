import { Bot, type BotError, type Context, type MiddlewareFn } from "grammy";
import type { MessageEntity, UserFromGetMe } from "grammy/types";
import { COMMANDS, type CommandName } from "./command-list";
import type { AppConfig } from "./config";
import { send } from "./telegram";

/** A command handler. `args` is the text after the command, trimmed. */
export type CommandHandler = (ctx: Context, args: string) => Promise<void>;

export interface BotOptions {
  /** Replaces fetch for Telegram API calls. */
  telegramFetch?: typeof fetch;
  /** Replaces individual command handlers. */
  commandHandlers?: Partial<Record<CommandName, CommandHandler>>;
}

/** Replies, logging (not throwing) when Telegram refuses the message. */
export async function reply(ctx: Context, text: string): Promise<void> {
  const sent = await send(() => ctx.reply(text));
  if (!sent.ok) {
    console.warn(JSON.stringify({ message: "Reply not sent", chatId: ctx.chat?.id, error: sent.error }));
  }
}

// Placeholder replies until the commands are ported (GSB-8).
const notPortedYet: CommandHandler = (ctx) => reply(ctx, "This command is being rebuilt and will be back soon.");

const DEFAULT_HANDLERS: Record<CommandName, CommandHandler> = {
  start: notPortedYet,
  help: notPortedYet,
  add: notPortedYet,
  list: notPortedYet,
  remove: notPortedYet,
  stats: notPortedYet,
};

const UNKNOWN_COMMAND = "Unknown command. Type /help to see the available commands.";

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

function dispatcher(handlers: Record<CommandName, CommandHandler>): MiddlewareFn {
  return async (ctx) => {
    const command = ctx.message ? parseCommand(ctx.message, ctx.me.username) : null;
    if (command === null) {
      return;
    }
    if (isCommandName(command.name)) {
      await handlers[command.name](ctx, command.args);
    } else {
      await reply(ctx, UNKNOWN_COMMAND);
    }
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

function logUpdateError(error: BotError): void {
  console.error(
    JSON.stringify({
      message: "Update failed",
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    }),
  );
}

export function createBot(config: AppConfig, options: BotOptions = {}): Bot {
  const bot = new Bot(config.telegramBotToken, {
    // Validated in config.ts; getMe fields added in later Bot API versions
    // pass through unchanged.
    botInfo: config.botInfo as unknown as UserFromGetMe,
    client: options.telegramFetch ? { fetch: options.telegramFetch } : {},
  });

  // One failed update must never affect others: log it and answer 200, so
  // Telegram doesn't redeliver it. (bot.catch only applies to long polling;
  // with webhooks, errors need an error boundary around the handlers.)
  const handlers = bot.errorBoundary(logUpdateError);
  handlers.use(allowedChatsOnly(config.allowedChatIds));
  handlers.on("message:text", dispatcher({ ...DEFAULT_HANDLERS, ...options.commandHandlers }));
  return bot;
}
