import { TelegramBotService } from './bot';
import { PollingService } from './services/polling';
import { config } from './config';

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
    try {
      console.log('🚀 Starting GitHub Stars Telegram Bot...');
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Polling interval: ${config.bot.pollingIntervalMinutes} minutes`);
      console.log(`Max repos per chat: ${config.bot.maxReposPerChat}`);

      // Check if webhook mode is configured
      const isWebhookMode = !!(config.telegram.webhookUrl && config.telegram.webhookPort);
      const isExternalCron = config.cron.externalEnabled;

      console.log(`Bot mode: ${isWebhookMode ? 'Webhook' : 'Polling'}`);
      console.log(`Cron mode: ${isExternalCron ? 'External' : 'Internal'}`);

      if (isWebhookMode) {
        console.log(`Webhook URL: ${config.telegram.webhookUrl}`);
        console.log(`Webhook port: ${config.telegram.webhookPort}`);
      }

      if (isExternalCron) {
        console.log(`External cron API key: ${config.cron.apiKey ? 'Configured' : 'Not set (endpoint will be unprotected)'}`);
      }

      if (config.bot.allowedChatIds.length > 0) {
        console.log(`Restricted to chat IDs: ${config.bot.allowedChatIds.join(', ')}`);
      } else {
        console.log('No chat ID restrictions');
      }

      // Start the Telegram bot
      await this.bot.start();

      // Handle GitHub polling based on cron mode
      if (config.cron.externalEnabled) {
        console.log('External cron mode enabled - GitHub polling will be triggered via /poll endpoint');
        console.log('Internal cron scheduler disabled');
      } else {
        // Start scheduled polling for GitHub stars (this is different from Telegram polling)
        this.polling.startScheduledPolling();

        // Run an immediate polling cycle to check for any pending updates
        setTimeout(async () => {
          console.log('🔄 Running initial GitHub polling cycle...');
          await this.polling.runImmediatePolling();
        }, 5000); // Wait 5 seconds after startup
      }

      console.log('✅ Application started successfully!');
      if (isWebhookMode) {
        if (config.cron.externalEnabled) {
          console.log('Bot is running in webhook mode with external cron for GitHub polling.');
        } else {
          console.log('Bot is running in webhook mode and will check for new stars periodically.');
        }
      } else {
        if (config.cron.externalEnabled) {
          console.log('Bot is running in polling mode with external cron for GitHub polling.');
        } else {
          console.log('Bot is running in polling mode and will check for new stars periodically.');
        }
      }

    } catch (error) {
      console.error('❌ Failed to start application:', error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      console.log('🛑 Stopping application...');

      // Stop internal cron if it was started
      if (!config.cron.externalEnabled) {
        this.polling.stopScheduledPolling();
      }

      await this.bot.stop();

      console.log('✅ Application stopped gracefully');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
    }
  }

  setupGracefulShutdown(): void {
    const gracefulShutdown = (signal: string) => {
      console.log(`\n📡 Received ${signal}. Starting graceful shutdown...`);
      this.stop().then(() => {
        process.exit(0);
      }).catch((error) => {
        console.error('Error during graceful shutdown:', error);
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      this.stop().then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
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
    console.error('Fatal error starting application:', error);
    process.exit(1);
  });
}

export { Application };
