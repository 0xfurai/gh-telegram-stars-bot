# Telegram GitHub Stars Bot

A Telegram bot that notifies subscribers about new stars on GitHub repositories. Built with TypeScript, node-telegram-bot-api, and Supabase for data storage.

## Features

- 🌟 **Star Tracking**: Monitor GitHub repositories for new stars
- 🔔 **Real-time Notifications**: Get notified when repositories gain new stars
- 📊 **Multiple Subscriptions**: Track multiple repositories per user
- 🛡️ **Rate Limit Aware**: Respects GitHub API rate limits
- 📈 **Statistics**: View bot and repository statistics
- 🔒 **Access Control**: Optional chat ID restrictions

## Commands

- `/start` - Start the bot and show welcome message
- `/help` - Show help and available commands
- `/add <repo>` - Subscribe to a repository (e.g., `/add microsoft/vscode`)
- `/list` - Show your repository subscriptions
- `/remove <repo>` - Unsubscribe from a repository
- `/stats` - Show bot statistics

## Supported Repository Formats

- `owner/repo` (e.g., `microsoft/vscode`)
- GitHub URLs (e.g., `https://github.com/facebook/react`)

## Setup

### Prerequisites

- Node.js 18+ and npm
- Supabase project
- Telegram Bot Token
- GitHub Personal Access Token

### 1. Clone and Install

```bash
git clone <repository-url>
cd telegram-github-stars
npm install
```

### 2. Database Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Run the SQL commands from `database.sql` in your Supabase SQL editor
3. Note your Supabase URL and anon key

### 3. Environment Configuration

1. Copy the example environment file:
   ```bash
   cp env.example .env
   ```

2. Fill in your configuration:
   ```env
   # Telegram Bot Configuration
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

   # Supabase Configuration
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key

   # GitHub Configuration
   GITHUB_TOKEN=your_github_personal_access_token

   # Bot Configuration
   POLLING_INTERVAL_MINUTES=30
   MAX_REPOS_PER_CHAT=50

   # Optional: Restrict bot to specific chat IDs (comma-separated)
   ALLOWED_CHAT_IDS=

   # Development
   NODE_ENV=development
   ```

### 4. Get Required Tokens

#### Telegram Bot Token
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the instructions
3. Copy the bot token

#### GitHub Personal Access Token
1. Go to GitHub Settings > Developer settings > Personal access tokens
2. Generate a new token with `public_repo` scope
3. Copy the token

### 5. Verify Setup

Before running the bot, verify everything is configured correctly:
```bash
npm run troubleshoot
```

### 6. Run the Bot

Development mode with auto-restart:
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

## 🔧 Troubleshooting

### Common Issues

**Database Error: "Could not find the table 'public.repositories'"**
- Solution: Run the SQL from `database.sql` in your Supabase SQL Editor
- Verify: `npm run test-db`

**Telegram Error: "terminated by other getUpdates request"**
- Solution: Stop any other bot instances, wait 2 minutes, then restart
- Make sure you're not running the bot elsewhere

**GitHub Error: "Bad credentials"**
- Solution: Check your `GITHUB_TOKEN` in `.env`
- Create a new Personal Access Token if needed

**Quick Diagnosis:**
```bash
npm run troubleshoot  # Check all connections
npm run test-db      # Test database only
npm run test-polling # Test GitHub polling
```

## Configuration Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather | Required |
| `SUPABASE_URL` | Supabase project URL | Required |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | Required |
| `GITHUB_TOKEN` | GitHub personal access token | Required |
| `POLLING_INTERVAL_MINUTES` | How often to check for new stars | 30 |
| `MAX_REPOS_PER_CHAT` | Maximum repositories per user | 50 |
| `ALLOWED_CHAT_IDS` | Comma-separated list of allowed chat IDs | None (open to all) |
| `NODE_ENV` | Environment mode | development |

## Database Schema

The bot uses the following tables in Supabase:

- **chats** - Telegram chat/user information
- **repositories** - GitHub repository data
- **chat_repositories** - User subscriptions (many-to-many)
- **star_events** - Historical star count changes

## Architecture

```
src/
├── bot/
│   ├── index.ts          # Telegram bot service
│   └── handlers.ts       # Command handlers
├── services/
│   ├── database.ts       # Supabase database operations
│   ├── github.ts         # GitHub API client
│   └── polling.ts        # Star polling service
├── types/
│   └── database.ts       # TypeScript database types
├── config/
│   └── index.ts          # Configuration management
└── index.ts              # Application entry point
```

## API Rate Limits

The bot is designed to respect GitHub API rate limits:

- **Authenticated requests**: 5,000 per hour
- **Polling strategy**: Batched requests with delays
- **Rate limit monitoring**: Checks remaining calls before polling

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions:

1. Check the logs for error messages
2. Verify your environment configuration
3. Ensure your tokens have the correct permissions
4. Check GitHub API rate limits

## Inspired By

This project is inspired by [JanisV/release-bot](https://github.com/JanisV/release-bot), adapted for star tracking instead of release tracking.
