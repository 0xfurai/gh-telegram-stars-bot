import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { BotHandlers } from './handlers';
import { WebhookService } from '../services/webhook';
import { logger } from '../services/logger';

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
      logger.error('Telegram polling error', error, { component: 'telegram-bot' });

      // Handle the "terminated by other getUpdates request" error
      if (error.message && error.message.includes('terminated by other getUpdates')) {
        logger.warn('⚠️  Multiple bot instances detected. Stopping this instance', { component: 'telegram-bot' });
        process.exit(1);
      }
    });

    this.bot.on('webhook_error', (error) => {
      logger.error('Telegram webhook error', error, { component: 'telegram-bot' });
    });

    // Handle uncaught errors to prevent bot from crashing
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception in bot service', error, { component: 'telegram-bot' });
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection in bot service', reason as Error, {
        component: 'telegram-bot',
        promise: promise.toString()
      });
    });
  }

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, text, options);
      logger.debug('Message sent successfully', { chatId, component: 'telegram-bot' });
    } catch (error) {
      logger.error(`Failed to send message to chat ${chatId}`, error as Error, { chatId, component: 'telegram-bot' });
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

      logger.info('Star notification sent successfully', {
        chatId,
        repository: repoFullName,
        starsGained,
        totalStars,
        component: 'telegram-bot'
      });
    } catch (error) {
      logger.error(`Failed to send star notification to chat ${chatId}`, error as Error, {
        chatId,
        repository: repoFullName,
        starsGained,
        totalStars,
        component: 'telegram-bot'
      });
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
        logger.info('Telegram bot webhook stopped', { component: 'telegram-bot' });
      } else if (config.cron.externalEnabled && this.webhookService) {
        // Stop webhook server (used for external cron)
        await this.bot.deleteWebHook();
        await this.webhookService.stop();
        logger.info('Telegram bot polling and external cron server stopped', { component: 'telegram-bot' });
      } else {
        // Stop polling
        await this.bot.stopPolling();
        logger.info('Telegram bot polling stopped', { component: 'telegram-bot' });
      }
    } catch (error) {
      logger.error('Error stopping bot', error as Error, { component: 'telegram-bot' });
    }
  }

  async start(): Promise<void> {
    const correlationId = logger.startOperation('telegram-bot-startup');

    try {
      logger.info(`Starting Telegram bot in ${this.isWebhookMode ? 'webhook' : 'polling'} mode`, { correlationId, component: 'telegram-bot' });

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

        logger.info(`Bot started successfully in webhook mode: @${botInfo.username}`, {
          correlationId,
          component: 'telegram-bot',
          username: botInfo.username,
          webhookUrl: `${config.telegram.webhookUrl}/webhook`,
          externalCron: config.cron.externalEnabled
        });

        if (config.cron.externalEnabled) {
          logger.info(`External cron endpoint available: ${config.telegram.webhookUrl}/poll`, {
            correlationId,
            component: 'telegram-bot'
          });
        }
      } else if (config.cron.externalEnabled && this.webhookService) {
        // Start webhook server for external cron endpoint only
        await this.webhookService.start();

        // Remove any existing webhook since we're using polling for Telegram
        await this.bot.deleteWebHook();

        logger.info(`Bot started successfully in polling mode with external cron: @${botInfo.username}`, {
          correlationId,
          component: 'telegram-bot',
          username: botInfo.username,
          externalCronEndpoint: `http://localhost:${config.telegram.webhookPort}/poll`
        });
      } else {
        // Remove any existing webhook
        await this.bot.deleteWebHook();
        logger.info(`Bot started successfully in polling mode: @${botInfo.username}`, {
          correlationId,
          component: 'telegram-bot',
          username: botInfo.username
        });
      }
      logger.endOperation(correlationId, true);
    } catch (error) {
      logger.endOperation(correlationId, false);
      logger.error('Failed to start bot', error as Error, { component: 'telegram-bot' });
      throw error;
    }
  }
}
