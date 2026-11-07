// The bot's commands, as shown in Telegram's command menu. No imports, so the
// setup script (scripts/telegram-setup.ts) can load it with plain Node.

/** Everyone's commands: the default menu, /start and /help. */
export const PUBLIC_COMMANDS = [
  { command: "start", description: "Start the bot and show the welcome message" },
  { command: "help", description: "Show help and available commands" },
  { command: "add", description: "Subscribe to a repository, e.g. /add microsoft/vscode" },
  { command: "list", description: "Show your repository subscriptions" },
  { command: "remove", description: "Unsubscribe from a repository" },
] as const;

/**
 * Only for ADMIN_CHAT_ID: the dispatcher (src/bot.ts) answers them like an
 * unknown command anywhere else. They're never in the command menu, which is
 * the same for every chat; /help lists them in the admin chat. /stats shows
 * totals for the whole bot (chats, subscriptions), which aren't everyone's
 * business.
 */
export const ADMIN_COMMANDS = [{ command: "stats", description: "Show bot statistics (admin only)" }] as const;

export const COMMANDS = [...PUBLIC_COMMANDS, ...ADMIN_COMMANDS] as const;

export type CommandName = (typeof COMMANDS)[number]["command"];
