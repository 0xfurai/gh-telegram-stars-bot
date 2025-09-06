import { TelegramBotService } from './bot';
import { PollingService } from './services/polling';
import { config } from './config';
import { logger } from './services/logger';

class Application {
  private bot: TelegramBotService;
  private polling: PollingService;

  constructor() {
    this.bot = new TelegramBotService();
    this.polling = new PollingService();

    // Connect services
    this.polling.setBotService(this.bot);
    this.bot.setPollingService(this.polling);
  }

  async start(): Promise<void> {
    const correlationId = logger.startOperation('application-startup');

    try {
      logger.info('🚀 Starting GitHub Stars Telegram Bot', { correlationId });
      logger.info('Application configuration loaded', {
        correlationId,
        environment: config.nodeEnv,
        pollingInterval: config.bot.pollingIntervalMinutes,
        maxReposPerChat: config.bot.maxReposPerChat,
        logLevel: config.logging.level
      });

      // Check if webhook mode is configured
      const isWebhookMode = !!(config.telegram.webhookUrl && config.telegram.webhookPort);
      const isExternalCron = config.cron.externalEnabled;

      logger.info('Bot configuration', {
        correlationId,
        botMode: isWebhookMode ? 'Webhook' : 'Polling',
        cronMode: isExternalCron ? 'External' : 'Internal',
        webhookUrl: isWebhookMode ? config.telegram.webhookUrl : undefined,
        webhookPort: isWebhookMode ? config.telegram.webhookPort : undefined,
        externalCronApiKey: isExternalCron ? (config.cron.apiKey ? 'Configured' : 'Not set') : undefined,
        allowedChatIds: config.bot.allowedChatIds.length > 0 ? config.bot.allowedChatIds : 'No restrictions'
      });

      // Start the Telegram bot
      await this.bot.start();

      // Handle GitHub polling based on cron mode
      if (config.cron.externalEnabled) {
        logger.info('External cron mode enabled - GitHub polling will be triggered via /poll endpoint', { correlationId });
        logger.info('Internal cron scheduler disabled', { correlationId });
      } else {
        // Start scheduled polling for GitHub stars (this is different from Telegram polling)
        this.polling.startScheduledPolling();

        // Run an immediate polling cycle to check for any pending updates
        setTimeout(async () => {
          logger.info('🔄 Running initial GitHub polling cycle', { correlationId });
          await this.polling.runImmediatePolling();
        }, 5000); // Wait 5 seconds after startup
      }

      logger.endOperation(correlationId, true, {
        botMode: isWebhookMode ? 'webhook' : 'polling',
        cronMode: isExternalCron ? 'external' : 'internal'
      });

      logger.info('✅ Application started successfully', {
        mode: `${isWebhookMode ? 'webhook' : 'polling'} mode with ${isExternalCron ? 'external' : 'internal'} cron`
      });

    } catch (error) {
      logger.endOperation(correlationId, false);
      logger.error('❌ Failed to start application', error as Error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    const correlationId = logger.startOperation('application-shutdown');

    try {
      logger.info('🛑 Stopping application', { correlationId });

      // Stop internal cron if it was started
      if (!config.cron.externalEnabled) {
        this.polling.stopScheduledPolling();
        logger.info('Internal cron scheduler stopped', { correlationId });
      }

      await this.bot.stop();

      logger.endOperation(correlationId, true);
      logger.info('✅ Application stopped gracefully');
    } catch (error) {
      logger.endOperation(correlationId, false);
      logger.error('❌ Error during shutdown', error as Error);
    }
  }

  setupGracefulShutdown(): void {
    const gracefulShutdown = (signal: string) => {
      logger.warn(`📡 Received ${signal}. Starting graceful shutdown`, { signal });
      this.stop().then(() => {
        process.exit(0);
      }).catch((error) => {
        logger.error('Error during graceful shutdown', error as Error, { signal });
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception - terminating application', error);
      this.stop().then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection - terminating application', reason as Error, { promise: promise.toString() });
      this.stop().then(() => process.exit(1));
    });
  }
}

// Start the application
async function main() {
  const app = new Application();

  // Setup graceful shutdown handlers
  app.setupGracefulShutdown();

  // Start the application
  await app.start();
}

// Only run if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error starting application', error as Error);
    process.exit(1);
  });
}

export { Application };
