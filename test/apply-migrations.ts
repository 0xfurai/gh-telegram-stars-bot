import { applyD1Migrations, env } from "cloudflare:test";

// Builds the schema in the test database from migrations/, the same files
// `wrangler d1 migrations apply` uses. Safe to run more than once.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
