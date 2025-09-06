import dotenv from "dotenv";

dotenv.config();

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    webhookUrl: process.env.WEBHOOK_URL || "",
    webhookPort: parseInt(process.env.PORT || "3000"),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  },
  github: {
    token: process.env.GITHUB_TOKEN || "",
  },
  bot: {
    pollingIntervalMinutes: parseInt(
      process.env.POLLING_INTERVAL_MINUTES || "30"
    ),
    maxReposPerChat: parseInt(process.env.MAX_REPOS_PER_CHAT || "50"),
    allowedChatIds: process.env.ALLOWED_CHAT_IDS
      ? process.env.ALLOWED_CHAT_IDS.split(",").map((id) => parseInt(id.trim()))
      : [],
  },
  cron: {
    externalEnabled: process.env.EXTERNAL_CRON_ENABLED === "true",
    apiKey: process.env.CRON_API_KEY || "",
  },
  nodeEnv: process.env.NODE_ENV || "development",
};

// Validate required environment variables
const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "GITHUB_TOKEN",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
