import cron from 'node-cron';
import { DatabaseService } from './database';
import { GitHubService } from './github';
import { TelegramBotService } from '../bot';
import { config } from '../config';

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
      console.log('Polling already in progress, skipping...');
      return [];
    }

    this.isPolling = true;
    const startTime = Date.now();
    const starChangeEvents: StarChangeEvent[] = [];

    try {
      console.log('Starting repository polling...');

      const repositories = await this.db.getAllRepositories();
      console.log(`Found ${repositories.length} repositories to check`);

      if (repositories.length === 0) {
        console.log('No repositories to poll');
        return [];
      }

      // Check rate limit before starting
      const rateLimitStatus = await this.github.getRateLimitStatus();
      console.log(`GitHub API rate limit: ${rateLimitStatus.remaining}/${rateLimitStatus.limit}`);

      if (rateLimitStatus.remaining < repositories.length) {
        console.warn(`Not enough API calls remaining (${rateLimitStatus.remaining}) for ${repositories.length} repositories. Skipping this cycle.`);
        return [];
      }

      // Process repositories in batches to avoid overwhelming the API
      const batchSize = 10;
      const batches = this.chunkArray(repositories, batchSize);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} repositories)`);

        const batchPromises = batch.map(async (repo) => {
          try {
            const [owner, repoName] = repo.full_name.split('/');
            const currentStars = await this.github.getRepositoryStarCount(owner, repoName);

            if (currentStars !== repo.stars_count) {
              console.log(`⭐ Star count changed for ${repo.full_name}: ${repo.stars_count} → ${currentStars}`);

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
            console.error(`Error checking stars for ${repo.full_name}:`, error);
          }
        });

        await Promise.all(batchPromises);

        // Add delay between batches to be respectful to the API
        if (i < batches.length - 1) {
          await this.sleep(1000); // 1 second delay
        }
      }

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      console.log(`Polling completed in ${duration}s. Found ${starChangeEvents.length} repositories with new stars.`);

      return starChangeEvents;

    } catch (error) {
      console.error('Error during polling:', error);
      return [];
    } finally {
      this.isPolling = false;
    }
  }

  async notifySubscribers(starChangeEvents: StarChangeEvent[]): Promise<void> {
    if (!this.bot || starChangeEvents.length === 0) {
      return;
    }

    console.log(`Sending notifications for ${starChangeEvents.length} star change events...`);

    for (const event of starChangeEvents) {
      try {
        const subscribers = await this.db.getSubscribersForRepository(event.repositoryId);
        console.log(`Notifying ${subscribers.length} subscribers for ${event.fullName}`);

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
            console.error(`Failed to notify chat ${chatId}:`, error);
          }
        });

        await Promise.all(notificationPromises);
      } catch (error) {
        console.error(`Error notifying subscribers for ${event.fullName}:`, error);
      }
    }
  }

  async runPollingCycle(): Promise<void> {
    try {
      const starChangeEvents = await this.pollRepositories();
      await this.notifySubscribers(starChangeEvents);
    } catch (error) {
      console.error('Error in polling cycle:', error);
    }
  }

  startScheduledPolling(): void {
    if (this.cronJob) {
      console.log('Polling is already scheduled');
      return;
    }

    const cronExpression = `*/${config.bot.pollingIntervalMinutes} * * * *`;
    console.log(`Scheduling polling every ${config.bot.pollingIntervalMinutes} minutes (${cronExpression})`);

    this.cronJob = cron.schedule(cronExpression, async () => {
      console.log('🔄 Starting scheduled polling cycle...');
      await this.runPollingCycle();
    }, {
      scheduled: false,
    });

    this.cronJob.start();
    console.log('✅ Scheduled polling started');
  }

  stopScheduledPolling(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('⏹️ Scheduled polling stopped');
    }
  }

  async runImmediatePolling(): Promise<void> {
    console.log('🔄 Running immediate polling cycle...');
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
