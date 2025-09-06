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
- Consider switching to webhook mode to avoid this issue

**GitHub Error: "Bad credentials"**
- Solution: Check your `GITHUB_TOKEN` in `.env`
- Create a new Personal Access Token if needed

**Webhook Error: "Webhook not receiving updates"**
- Verify your `WEBHOOK_URL` is publicly accessible via HTTPS
- Check that the webhook secret matches if configured
- Test the webhook endpoint: `curl https://your-domain.com/health`
- Ensure port 3000 (or your configured port) is accessible

**External Cron Error: "Polling endpoint not working"**
- Verify `EXTERNAL_CRON_ENABLED=true` is set in your environment
- Check that the API key matches if configured: `curl -X POST http://localhost:3000/poll -H "Authorization: Bearer your_api_key"`
- Ensure the server is running and the webhook service is started
- Check logs for authentication errors

**Quick Diagnosis:**
```bash
npm run troubleshoot  # Check all connections
npm run test-db      # Test database only
npm run test-polling # Test GitHub polling
npm run test-webhook # Test webhook configuration
npm run test-cron    # Test external cron configuration
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
| `WEBHOOK_URL` | Public URL for webhook (optional) | None (uses polling) |
| `PORT` | Port for webhook server | 3000 |
| `WEBHOOK_SECRET` | Secret token for webhook security | None |
| `EXTERNAL_CRON_ENABLED` | Use external cron instead of internal scheduler | false |
| `CRON_API_KEY` | API key for external cron endpoint security | None |
| `NODE_ENV` | Environment mode | development |
| `LOG_LEVEL` | Logging level (error, warn, info, debug) | debug (dev), info (prod) |

## Bot Modes

The bot supports two modes of operation:

### 1. Polling Mode (Default)
- Bot actively polls Telegram servers for updates
- Easier to set up, works behind NAT/firewall
- Uses more resources as it continuously polls
- Enabled when `WEBHOOK_URL` is not configured

### 2. Webhook Mode (Recommended for Production)
- Telegram sends updates directly to your server
- More efficient and responsive
- Requires a publicly accessible HTTPS URL
- Enabled when `WEBHOOK_URL` is configured

#### Setting up Webhook Mode

1. **Get a public HTTPS URL** (required by Telegram):
   - Use a service like ngrok for testing: `ngrok http 3000`
   - Use a reverse proxy (nginx) with SSL certificate
   - Use a cloud service with HTTPS support

2. **Configure webhook environment variables**:
   ```env
   WEBHOOK_URL=https://your-domain.com
   PORT=3000
   WEBHOOK_SECRET=your_secure_random_string
   ```

3. **Security considerations**:
   - Always use HTTPS (required by Telegram)
   - Set a strong `WEBHOOK_SECRET` for additional security
   - Consider IP whitelisting for Telegram's servers

4. **Testing with ngrok**:
   ```bash
   # Terminal 1: Start ngrok
   ngrok http 3000

   # Terminal 2: Update .env with ngrok URL
   WEBHOOK_URL=https://abc123.ngrok.io

   # Terminal 3: Start the bot
   npm run dev
   ```

## External Cron Setup

For production deployments, you might want to use an external cron service (like GitHub Actions, cloud cron jobs, or cron services) instead of the internal scheduler. This provides better control, monitoring, and reliability.

### 1. Enable External Cron Mode

Add these environment variables to your `.env`:

```env
EXTERNAL_CRON_ENABLED=true
CRON_API_KEY=your_secure_api_key_here
```

### 2. External Cron Endpoint

When external cron is enabled, the bot exposes a `/poll` endpoint that can be called to trigger GitHub polling:

- **URL**: `POST http://your-server:3000/poll` (or your webhook URL + `/poll`)
- **Authentication**: `Authorization: Bearer your_secure_api_key_here` (if `CRON_API_KEY` is set)
- **Response**: `{"ok": true, "message": "Polling cycle started", "timestamp": "..."}`

### 3. Example External Cron Setups

#### Using cURL (for testing):
```bash
curl -X POST http://localhost:3000/poll \
  -H "Authorization: Bearer your_secure_api_key_here"
```

#### Using GitHub Actions:
```yaml
name: Trigger Bot Polling
on:
  schedule:
    - cron: '*/30 * * * *'  # Every 30 minutes

jobs:
  trigger-polling:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Bot Polling
        run: |
          curl -X POST ${{ secrets.BOT_URL }}/poll \
            -H "Authorization: Bearer ${{ secrets.CRON_API_KEY }}"
```

#### Using cloud cron services:
- **Google Cloud Scheduler**: Create a job that makes POST request to your `/poll` endpoint
- **AWS EventBridge**: Set up a scheduled rule to invoke your endpoint
- **Vercel Cron**: Use Vercel's cron jobs to call your endpoint

### 4. Benefits of External Cron

- **Reliability**: Cloud cron services are more reliable than internal schedulers
- **Monitoring**: Better visibility into cron job execution and failures
- **Scaling**: Doesn't consume resources on your main server
- **Flexibility**: Easy to change schedules without redeploying
- **Redundancy**: Can set up multiple cron sources for backup

### 5. Security Considerations

- Always set a strong `CRON_API_KEY` in production
- Use HTTPS for the polling endpoint
- Consider IP whitelisting for additional security
- Monitor for unauthorized access attempts

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

## Logging

The bot features structured logging optimized for cloud environments:

### Features

- **Structured JSON Logging**: All logs are output in JSON format for easy parsing by log aggregation services
- **Correlation IDs**: Each operation gets a unique correlation ID for tracking requests across services
- **Contextual Metadata**: Logs include relevant context like chat IDs, repository names, user IDs, etc.
- **Log Levels**: Configurable log levels (error, warn, info, debug)
- **Cloud-Ready**: Optimized for services like CloudWatch, Datadog, Splunk, etc.

### Log Levels

- **error**: Critical errors and exceptions
- **warn**: Warning conditions that should be monitored
- **info**: General information about operations (default for production)
- **debug**: Detailed debugging information (default for development)

### Configuration

Set the log level using the `LOG_LEVEL` environment variable:

```bash
# Development (verbose)
LOG_LEVEL=debug

# Production (minimal)
LOG_LEVEL=info
```

### Production Logging

In production (`NODE_ENV=production`), logs are:

- Output in structured JSON format
- Saved to rotating daily files in the `logs/` directory
- Automatically cleaned up after 14 days
- Limited to 20MB per file with automatic rotation

### Development Logging

In development, logs are:

- Colorized and human-readable
- Include timestamps and correlation IDs
- Output only to console

### Log Context

Each log entry includes contextual information:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Star notification sent successfully",
  "service": "telegram-github-stars",
  "environment": "production",
  "correlationId": "1642248600000-abc123def",
  "component": "telegram-bot",
  "chatId": 123456789,
  "repository": "microsoft/vscode",
  "starsGained": 5,
  "totalStars": 150000
}
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
