import TelegramBot from 'node-telegram-bot-api';
import { DatabaseService } from '../services/database';
import { GitHubService } from '../services/github';
import { config } from '../config';

export class BotHandlers {
  private db: DatabaseService;
  private github: GitHubService;

  constructor() {
    this.db = new DatabaseService();
    this.github = new GitHubService();
  }

  private isAuthorizedChat(chatId: number): boolean {
    if (config.bot.allowedChatIds.length === 0) {
      return true; // No restrictions
    }
    return config.bot.allowedChatIds.includes(chatId);
  }

  async handleStart(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      await bot.sendMessage(chatId, '❌ You are not authorized to use this bot.');
      return;
    }

    try {
      await this.db.getOrCreateChat(chatId);

      const welcomeMessage = `
🌟 *Welcome to GitHub Stars Bot!*

I'll help you track new stars on your favorite GitHub repositories.

*Available commands:*
/add \`owner/repo\` - Subscribe to a repository
/list - Show your subscriptions
/remove \`owner/repo\` - Unsubscribe from a repository
/stats - Show bot statistics
/help - Show this help message

*Examples:*
\`/add microsoft/vscode\`
\`/add https://github.com/facebook/react\`

Just send me a repository URL or owner/repo format to get started! 🚀
      `;

      await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in handleStart:', error);
      await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    }
  }

  async handleHelp(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    const helpMessage = `
🌟 *GitHub Stars Bot Help*

*Commands:*
/start - Show welcome message
/add \`owner/repo\` - Subscribe to repository star notifications
/list - Show all your subscriptions
/remove \`owner/repo\` - Remove subscription
/stats - Show bot statistics
/help - Show this help message

*Supported formats:*
• \`owner/repo\` (e.g., \`microsoft/vscode\`)
• GitHub URLs (e.g., \`https://github.com/facebook/react\`)

*Features:*
• Get notified when repositories gain new stars
• Track multiple repositories
• Real-time star count updates
• Statistics and insights

*Examples:*
\`/add microsoft/vscode\`
\`/add https://github.com/facebook/react\`
\`/remove microsoft/vscode\`

Need help? Just send me a repository name or URL! 🚀
    `;

    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  }

  async handleAdd(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    try {
      const input = match?.[1]?.trim();
      if (!input) {
        await bot.sendMessage(
          chatId,
          'Please provide a repository name or URL.\n\nExamples:\n`/add microsoft/vscode`\n`/add https://github.com/facebook/react`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Parse repository from input
      const parsed = this.github.parseRepositoryUrl(input);
      if (!parsed) {
        await bot.sendMessage(
          chatId,
          '❌ Invalid repository format. Please use:\n• `owner/repo` format\n• Full GitHub URL',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Check if user has reached the limit
      await this.db.getOrCreateChat(chatId);
      const subscriptions = await this.db.getChatSubscriptions(chatId);

      if (subscriptions.length >= config.bot.maxReposPerChat) {
        await bot.sendMessage(
          chatId,
          `❌ You've reached the maximum limit of ${config.bot.maxReposPerChat} repositories per chat.`
        );
        return;
      }

      // Fetch repository from GitHub
      const githubRepo = await this.github.getRepository(parsed.owner, parsed.repo);
      if (!githubRepo) {
        await bot.sendMessage(
          chatId,
          `❌ Repository \`${parsed.owner}/${parsed.repo}\` not found on GitHub.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Add to database
      const dbRepo = await this.db.getOrCreateRepository(githubRepo);
      await this.db.addSubscription(chatId, dbRepo.id);

      const message = `
✅ *Successfully subscribed!*

📦 **${githubRepo.full_name}**
⭐ ${githubRepo.stargazers_count.toLocaleString()} stars
🔗 ${githubRepo.html_url}

${githubRepo.description ? `📝 ${githubRepo.description}` : ''}

${githubRepo.archived ? '⚠️ *Note: This repository is archived*' : ''}

You'll receive notifications when this repository gains new stars! 🌟
      `;

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });

    } catch (error) {
      console.error('Error in handleAdd:', error);
      await bot.sendMessage(chatId, '❌ An error occurred while adding the repository. Please try again.');
    }
  }

  async handleList(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    try {
      await this.db.getOrCreateChat(chatId);
      const subscriptions = await this.db.getChatSubscriptions(chatId);

      if (subscriptions.length === 0) {
        await bot.sendMessage(
          chatId,
          '📭 You have no repository subscriptions yet.\n\nUse `/add owner/repo` to subscribe to a repository!',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = `🌟 *Your Repository Subscriptions* (${subscriptions.length}/${config.bot.maxReposPerChat})\n\n`;

      subscriptions
        .sort((a, b) => b.stars_count - a.stars_count)
        .forEach((repo, index) => {
          const starsCount = repo.stars_count.toLocaleString();
          const archivedIndicator = repo.is_archived ? ' 📦' : '';
          message += `${index + 1}. **${repo.full_name}**${archivedIndicator}\n`;
          message += `   ⭐ ${starsCount} stars\n`;
          message += `   🔗 ${repo.html_url}\n\n`;
        });

      message += `💡 Use \`/remove owner/repo\` to unsubscribe from a repository.`;

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

    } catch (error) {
      console.error('Error in handleList:', error);
      await bot.sendMessage(chatId, '❌ An error occurred while fetching your subscriptions.');
    }
  }

  async handleRemove(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    try {
      const input = match?.[1]?.trim();
      if (!input) {
        await bot.sendMessage(
          chatId,
          '❌ Please provide a repository name.\n\nExample: `/remove microsoft/vscode`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Parse repository from input
      const parsed = this.github.parseRepositoryUrl(input);
      if (!parsed) {
        await bot.sendMessage(
          chatId,
          '❌ Invalid repository format. Please use `owner/repo` format.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await this.db.getOrCreateChat(chatId);
      const subscriptions = await this.db.getChatSubscriptions(chatId);

      const repoToRemove = subscriptions.find(
        repo => repo.full_name.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase()
      );

      if (!repoToRemove) {
        await bot.sendMessage(
          chatId,
          `❌ You are not subscribed to \`${parsed.owner}/${parsed.repo}\`.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await this.db.removeSubscription(chatId, repoToRemove.id);

      await bot.sendMessage(
        chatId,
        `✅ Successfully unsubscribed from **${repoToRemove.full_name}**!`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Error in handleRemove:', error);
      await bot.sendMessage(chatId, '❌ An error occurred while removing the repository.');
    }
  }

  async handleStats(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    try {
      const stats = await this.db.getStats();
      const rateLimitStatus = await this.github.getRateLimitStatus();

      const message = `
📊 *Bot Statistics*

📦 **Repositories:** ${stats.totalRepositories.toLocaleString()}
👥 **Users:** ${stats.totalChats.toLocaleString()}
🔔 **Subscriptions:** ${stats.totalSubscriptions.toLocaleString()}
⭐ **Star Events:** ${stats.totalStarEvents.toLocaleString()}

🔧 **GitHub API:**
• Rate limit: ${rateLimitStatus.remaining.toLocaleString()}/${rateLimitStatus.limit.toLocaleString()}
• Resets at: ${rateLimitStatus.reset.toLocaleTimeString()}

🤖 **Bot Info:**
• Polling interval: ${config.bot.pollingIntervalMinutes} minutes
• Max repos per chat: ${config.bot.maxReposPerChat}
      `;

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Error in handleStats:', error);
      await bot.sendMessage(chatId, '❌ An error occurred while fetching statistics.');
    }
  }

  async handleMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    if (!this.isAuthorizedChat(chatId) || !text) {
      return;
    }

    // Check if it's a repository URL or owner/repo format
    const parsed = this.github.parseRepositoryUrl(text);
    if (parsed) {
      // Treat it as an add command
      const match: RegExpExecArray = [text, text] as any;
      match.index = 0;
      match.input = text;
      await this.handleAdd(bot, msg, match);
      return;
    }

    // Default response for unrecognized messages
    await bot.sendMessage(
      chatId,
      '❓ I didn\'t understand that. Send me a repository URL or use one of the available commands.\n\nType /help to see all available commands.',
      { parse_mode: 'Markdown' }
    );
  }

  async handleUnknownCommand(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.isAuthorizedChat(chatId)) {
      return;
    }

    await bot.sendMessage(
      chatId,
      '❓ Unknown command. Type /help to see all available commands.',
      { parse_mode: 'Markdown' }
    );
  }
}
