import cron from 'node-cron';
import { DatabaseService } from './database';
import { GitHubService } from './github';
import { TelegramBotService } from '../bot';
import { config } from '../config';
import { logger } from './logger';

export interface StarChangeEvent {
  repositoryId: number;
  fullName: string;
  htmlUrl: string;
  previousStars: number;
  currentStars: number;
  starsGained: number;
}

export class PollingService {
  private db: DatabaseService;
  private github: GitHubService;
  private bot: TelegramBotService | null = null;
  private cronJob: cron.ScheduledTask | null = null;
  private isPolling = false;

  constructor() {
    this.db = new DatabaseService();
    this.github = new GitHubService();
  }

  setBotService(bot: TelegramBotService): void {
    this.bot = bot;
  }

  async pollRepositories(): Promise<StarChangeEvent[]> {
    if (this.isPolling) {
      logger.warn('Polling already in progress, skipping', { component: 'polling' });
      return [];
    }

    this.isPolling = true;
    const correlationId = logger.startOperation('repository-polling');
    const starChangeEvents: StarChangeEvent[] = [];

    try {
      logger.pollingOperation('Starting repository polling', { correlationId });

      const repositories = await this.db.getAllRepositories();
      logger.info(`Found ${repositories.length} repositories to check`, {
        correlationId,
        repositoryCount: repositories.length,
        component: 'polling'
      });

      if (repositories.length === 0) {
        logger.info('No repositories to poll', { correlationId, component: 'polling' });
        return [];
      }

      // Check rate limit before starting
      const rateLimitStatus = await this.github.getRateLimitStatus();
      logger.info('GitHub API rate limit status', {
        correlationId,
        remaining: rateLimitStatus.remaining,
        limit: rateLimitStatus.limit,
        component: 'polling'
      });

      if (rateLimitStatus.remaining < repositories.length) {
        logger.warn(`Not enough API calls remaining for ${repositories.length} repositories. Skipping cycle`, {
          correlationId,
          remaining: rateLimitStatus.remaining,
          required: repositories.length,
          component: 'polling'
        });
        return [];
      }

      // Process repositories in batches to avoid overwhelming the API
      const batchSize = 10;
      const batches = this.chunkArray(repositories, batchSize);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.debug(`Processing batch ${i + 1}/${batches.length}`, {
          correlationId,
          batchNumber: i + 1,
          totalBatches: batches.length,
          batchSize: batch.length,
          component: 'polling'
        });

        const batchPromises = batch.map(async (repo) => {
          try {
            const [owner, repoName] = repo.full_name.split('/');
            const currentStars = await this.github.getRepositoryStarCount(owner, repoName);

            if (currentStars !== repo.stars_count) {
              logger.githubOperation(`⭐ Star count changed for ${repo.full_name}`, repo.full_name, {
                correlationId,
                previousStars: repo.stars_count,
                currentStars,
                change: currentStars - repo.stars_count
              });

              // Update repository in database
              await this.db.updateRepositoryStarsCount(repo.id, currentStars);

              // Create star event if stars increased
              if (currentStars > repo.stars_count) {
                await this.db.createStarEvent(repo.id, currentStars, repo.stars_count);

                const starChangeEvent: StarChangeEvent = {
                  repositoryId: repo.id,
                  fullName: repo.full_name,
                  htmlUrl: repo.html_url,
                  previousStars: repo.stars_count,
                  currentStars,
                  starsGained: currentStars - repo.stars_count,
                };

                starChangeEvents.push(starChangeEvent);
              }
            }
          } catch (error) {
            logger.error(`Error checking stars for ${repo.full_name}`, error as Error, {
              correlationId,
              repository: repo.full_name,
              component: 'polling'
            });
          }
        });

        await Promise.all(batchPromises);

        // Add delay between batches to be respectful to the API
        if (i < batches.length - 1) {
          await this.sleep(1000); // 1 second delay
        }
      }

      logger.endOperation(correlationId, true, {
        starChangeEvents: starChangeEvents.length,
        repositoriesChecked: repositories.length
      });

      return starChangeEvents;

    } catch (error) {
      logger.endOperation(correlationId, false);
      logger.error('Error during polling', error as Error, { correlationId, component: 'polling' });
      return [];
    } finally {
      this.isPolling = false;
    }
  }

  async notifySubscribers(starChangeEvents: StarChangeEvent[]): Promise<void> {
    if (!this.bot || starChangeEvents.length === 0) {
      return;
    }

    const correlationId = logger.startOperation('notify-subscribers');
    logger.info(`Sending notifications for ${starChangeEvents.length} star change events`, {
      correlationId,
      eventCount: starChangeEvents.length,
      component: 'polling'
    });

    for (const event of starChangeEvents) {
      try {
        const subscribers = await this.db.getSubscribersForRepository(event.repositoryId);
        logger.info(`Notifying ${subscribers.length} subscribers for ${event.fullName}`, {
          correlationId,
          repository: event.fullName,
          subscriberCount: subscribers.length,
          starsGained: event.starsGained,
          component: 'polling'
        });

        const notificationPromises = subscribers.map(async (chatId) => {
          try {
            await this.bot!.sendStarNotification(
              chatId,
              event.fullName,
              event.htmlUrl,
              event.starsGained,
              event.currentStars
            );
          } catch (error) {
            logger.error(`Failed to notify chat ${chatId}`, error as Error, {
              correlationId,
              chatId,
              repository: event.fullName,
              component: 'polling'
            });
          }
        });

        await Promise.all(notificationPromises);
      } catch (error) {
        logger.error(`Error notifying subscribers for ${event.fullName}`, error as Error, {
          correlationId,
          repository: event.fullName,
          component: 'polling'
        });
      }
    }

    logger.endOperation(correlationId, true);
  }

  async runPollingCycle(): Promise<void> {
    const correlationId = logger.startOperation('polling-cycle');
    try {
      const starChangeEvents = await this.pollRepositories();
      await this.notifySubscribers(starChangeEvents);
      logger.endOperation(correlationId, true, { starChangeEvents: starChangeEvents.length });
    } catch (error) {
      logger.endOperation(correlationId, false);
      logger.error('Error in polling cycle', error as Error, { correlationId, component: 'polling' });
    }
  }

  startScheduledPolling(): void {
    if (this.cronJob) {
      logger.warn('Polling is already scheduled', { component: 'polling' });
      return;
    }

    const cronExpression = `*/${config.bot.pollingIntervalMinutes} * * * *`;
    logger.info(`Scheduling polling every ${config.bot.pollingIntervalMinutes} minutes`, {
      cronExpression,
      intervalMinutes: config.bot.pollingIntervalMinutes,
      component: 'polling'
    });

    this.cronJob = cron.schedule(cronExpression, async () => {
      logger.info('🔄 Starting scheduled polling cycle', { component: 'polling' });
      await this.runPollingCycle();
    }, {
      scheduled: false,
    });

    this.cronJob.start();
    logger.info('✅ Scheduled polling started', { component: 'polling' });
  }

  stopScheduledPolling(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info('⏹️ Scheduled polling stopped', { component: 'polling' });
    }
  }

  async runImmediatePolling(): Promise<void> {
    logger.info('🔄 Running immediate polling cycle', { component: 'polling' });
    await this.runPollingCycle();
  }

  getPollingStatus(): {
    isScheduled: boolean;
    isCurrentlyPolling: boolean;
    intervalMinutes: number;
  } {
    return {
      isScheduled: this.cronJob !== null,
      isCurrentlyPolling: this.isPolling,
      intervalMinutes: config.bot.pollingIntervalMinutes,
    };
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
