import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { BotHandlers } from './handlers';

export class TelegramBotService {
  private bot: TelegramBot;
  private handlers: BotHandlers;

  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.handlers = new BotHandlers();
    this.setupHandlers();
    this.setupErrorHandlers();
  }

  private setupHandlers(): void {
    // Command handlers
    this.bot.onText(/\/start/, (msg) => {
      this.handlers.handleStart(this.bot, msg);
    });

    this.bot.onText(/\/help/, (msg) => {
      this.handlers.handleHelp(this.bot, msg);
    });

    this.bot.onText(/\/add(?:\s+(.+))?/, (msg, match) => {
      this.handlers.handleAdd(this.bot, msg, match);
    });

    this.bot.onText(/\/list/, (msg) => {
      this.handlers.handleList(this.bot, msg);
    });

    this.bot.onText(/\/remove(?:\s+(.+))?/, (msg, match) => {
      this.handlers.handleRemove(this.bot, msg, match);
    });

    this.bot.onText(/\/stats/, (msg) => {
      this.handlers.handleStats(this.bot, msg);
    });

    // Handle all messages (both commands and regular text)
    this.bot.on('message', (msg) => {
      if (msg.text && msg.text.startsWith('/')) {
        // Handle unknown commands
        const command = msg.text.split(' ')[0].substring(1); // Remove the '/'
        const knownCommands = ['start', 'help', 'add', 'list', 'remove', 'stats'];

        if (!knownCommands.includes(command)) {
          this.handlers.handleUnknownCommand(this.bot, msg);
        }
        // Known commands are handled by onText handlers above, so we don't need to do anything
      } else {
        // Handle regular messages (non-commands)
        this.handlers.handleMessage(this.bot, msg);
      }
    });
  }

  private setupErrorHandlers(): void {
    this.bot.on('polling_error', (error) => {
      console.error('Telegram polling error:', error);

      // Handle the "terminated by other getUpdates request" error
      if (error.message && error.message.includes('terminated by other getUpdates')) {
        console.log('⚠️  Multiple bot instances detected. Stopping this instance...');
        process.exit(1);
      }
    });

    this.bot.on('webhook_error', (error) => {
      console.error('Telegram webhook error:', error);
    });

    // Handle uncaught errors to prevent bot from crashing
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
  }

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      console.error(`Failed to send message to chat ${chatId}:`, error);
      throw error;
    }
  }

  async sendStarNotification(chatId: number, repoFullName: string, repoUrl: string, starsGained: number, totalStars: number): Promise<void> {
    const message = `
🌟 *New Stars Alert!*

📦 **${repoFullName}**
✨ +${starsGained.toLocaleString()} new star${starsGained > 1 ? 's' : ''}
⭐ Total: ${totalStars.toLocaleString()} stars

🔗 ${repoUrl}
    `;

    try {
      await this.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
    } catch (error) {
      console.error(`Failed to send star notification to chat ${chatId}:`, error);
    }
  }

  getBot(): TelegramBot {
    return this.bot;
  }

  async stop(): Promise<void> {
    try {
      await this.bot.stopPolling();
      console.log('Telegram bot stopped');
    } catch (error) {
      console.error('Error stopping bot:', error);
    }
  }

  async start(): Promise<void> {
    try {
      console.log('Starting Telegram bot...');

      // Set bot commands for better UX
      await this.bot.setMyCommands([
        { command: 'start', description: 'Start the bot and show welcome message' },
        { command: 'help', description: 'Show help and available commands' },
        { command: 'add', description: 'Subscribe to a repository (e.g., /add microsoft/vscode)' },
        { command: 'list', description: 'Show your repository subscriptions' },
        { command: 'remove', description: 'Unsubscribe from a repository' },
        { command: 'stats', description: 'Show bot statistics' },
      ]);

      const botInfo = await this.bot.getMe();
      console.log(`Bot started successfully: @${botInfo.username}`);
    } catch (error) {
      console.error('Failed to start bot:', error);
      throw error;
    }
  }
}
