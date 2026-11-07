// Valid Worker settings for tests, used as bindings in vitest.config.ts.
// Fake values only: tests never call real services.
export const TEST_SETTINGS = {
  TELEGRAM_BOT_TOKEN: "123456789:TEST-token-0123456789abcdefghijklmnop",
  GITHUB_TOKEN: "ghp_test0123456789",
  WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
  NOTIFICATIONS: "dry-run",
  BOT_INFO: JSON.stringify({
    id: 123456789,
    is_bot: true,
    first_name: "Test bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  }),
} as const;
