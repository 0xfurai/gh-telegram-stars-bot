// The bot's commands, as shown in Telegram's command menu. No imports, so the
// setup script (scripts/telegram-setup.ts) can load it with plain Node.
export const COMMANDS = [
  { command: "start", description: "Start the bot and show the welcome message" },
  { command: "help", description: "Show help and available commands" },
  { command: "add", description: "Subscribe to a repository, e.g. /add microsoft/vscode" },
  { command: "list", description: "Show your repository subscriptions" },
  { command: "remove", description: "Unsubscribe from a repository" },
  { command: "stats", description: "Show bot statistics" },
] as const;

export type CommandName = (typeof COMMANDS)[number]["command"];
