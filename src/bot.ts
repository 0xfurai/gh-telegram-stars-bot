import { Bot, type BotError, type Context, type MiddlewareFn } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { COMMANDS, type CommandName } from "./command-list";
import type { AppConfig } from "./config";

export interface BotOptions {
  /** Replaces fetch for Telegram API calls (tests). */
  telegramFetch?: typeof fetch;
}

type CommandHandler = (ctx: Context) => Promise<unknown>;

// Placeholder replies until the commands are ported (GSB-8).
const notPortedYet: CommandHandler = (ctx) =>
  ctx.reply("This command is being rebuilt and will be back soon.");

const HANDLERS: Record<CommandName, CommandHandler> = {
  start: notPortedYet,
  help: notPortedYet,
  add: notPortedYet,
  list: notPortedYet,
  remove: notPortedYet,
  stats: notPortedYet,
};

/** Ignores every update from chats outside ALLOWED_CHAT_IDS, when it's set. */
function allowedChatsOnly(allowed: ReadonlySet<number> | null): MiddlewareFn {
  return async (ctx, next) => {
    if (allowed === null || (ctx.chat !== undefined && allowed.has(ctx.chat.id))) {
      await next();
    }
  };
}

/**
 * True for a message that starts with a command meant for this bot: either
 * `/cmd` or `/cmd@ThisBot`. `/cmd@OtherBot` in a group is for another bot,
 * and a command later in the text ("see /help") isn't a command.
 */
function startsWithCommandForUs(ctx: Context): boolean {
  const entity = ctx.message?.entities?.[0];
  const text = ctx.message?.text;
  if (entity?.type !== "bot_command" || entity.offset !== 0 || text === undefined) {
    return false;
  }
  const target = text.slice(1, entity.length).split("@")[1];
  return target === undefined || target.toLowerCase() === ctx.me.username.toLowerCase();
}

async function replyUnknownCommand(ctx: Context): Promise<void> {
  if (startsWithCommandForUs(ctx)) {
    await ctx.reply("Unknown command. Type /help to see the available commands.");
  }
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
    // Validated in config.ts (id, is_bot, first_name, username); the other
    // getMe fields pass through unchanged.
    botInfo: config.botInfo as unknown as UserFromGetMe,
    client: options.telegramFetch ? { fetch: options.telegramFetch } : {},
  });

  // One failed update must never affect others: log it and answer 200, so
  // Telegram doesn't redeliver it. (bot.catch only applies to long polling;
  // with webhooks, errors need an error boundary around the handlers.)
  const handlers = bot.errorBoundary(logUpdateError);

  handlers.use(allowedChatsOnly(config.allowedChatIds));
  for (const { command } of COMMANDS) {
    handlers.command(command, HANDLERS[command]);
  }
  // Reached only by commands that didn't match above.
  handlers.on("message::bot_command", replyUnknownCommand);
  return bot;
}
