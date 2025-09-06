import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { BotHandlers } from './handlers';
import { WebhookService } from '../services/webhook';

export class TelegramBotService {
  private bot: TelegramBot;
  private handlers: BotHandlers;
  private webhookService?: WebhookService;
  private isWebhookMode: boolean;

  constructor() {
    // Determine if we should use webhook mode
    this.isWebhookMode = !!(config.telegram.webhookUrl && config.telegram.webhookPort);

    // Initialize bot with appropriate mode
    this.bot = new TelegramBot(config.telegram.botToken, {
      polling: !this.isWebhookMode
    });

    this.handlers = new BotHandlers();
    this.setupHandlers();
    this.setupErrorHandlers();

    // Initialize webhook service if in webhook mode or external cron is enabled
    if (this.isWebhookMode || config.cron.externalEnabled) {
      this.webhookService = new WebhookService();
      this.setupWebhook();
    }
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

  private setupWebhook(): void {
    if (!this.webhookService) return;

    // Set up webhook message handler for Telegram updates
    if (this.isWebhookMode) {
      this.webhookService.setMessageHandler((update: any) => {
        this.bot.processUpdate(update);
      });
    }
  }

  setPollingService(pollingService: any): void {
    if (this.webhookService && config.cron.externalEnabled) {
      // Set up external cron polling handler
      this.webhookService.setPollingHandler(async () => {
        await pollingService.runPollingCycle();
      });
    }
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
      if (this.isWebhookMode) {
        // Delete webhook and stop webhook server
        await this.bot.deleteWebHook();
        if (this.webhookService) {
          await this.webhookService.stop();
        }
        console.log('Telegram bot webhook stopped');
      } else if (config.cron.externalEnabled && this.webhookService) {
        // Stop webhook server (used for external cron)
        await this.bot.deleteWebHook();
        await this.webhookService.stop();
        console.log('Telegram bot polling and external cron server stopped');
      } else {
        // Stop polling
        await this.bot.stopPolling();
        console.log('Telegram bot polling stopped');
      }
    } catch (error) {
      console.error('Error stopping bot:', error);
    }
  }

  async start(): Promise<void> {
    try {
      console.log(`Starting Telegram bot in ${this.isWebhookMode ? 'webhook' : 'polling'} mode...`);

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

      if (this.isWebhookMode && this.webhookService) {
        // Start webhook server
        await this.webhookService.start();

        // Set webhook URL
        await this.bot.setWebHook(config.telegram.webhookUrl + '/webhook', {
          secret_token: config.telegram.webhookSecret || undefined,
        });

        console.log(`Bot started successfully in webhook mode: @${botInfo.username}`);
        console.log(`Webhook URL: ${config.telegram.webhookUrl}/webhook`);

        if (config.cron.externalEnabled) {
          console.log(`External cron endpoint available: ${config.telegram.webhookUrl}/poll`);
        }
      } else if (config.cron.externalEnabled && this.webhookService) {
        // Start webhook server for external cron endpoint only
        await this.webhookService.start();

        // Remove any existing webhook since we're using polling for Telegram
        await this.bot.deleteWebHook();

        console.log(`Bot started successfully in polling mode with external cron: @${botInfo.username}`);
        console.log(`External cron endpoint: http://localhost:${config.telegram.webhookPort}/poll`);
      } else {
        // Remove any existing webhook
        await this.bot.deleteWebHook();
        console.log(`Bot started successfully in polling mode: @${botInfo.username}`);
      }
    } catch (error) {
      console.error('Failed to start bot:', error);
      throw error;
    }
  }
}
