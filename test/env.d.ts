import type { D1Migration } from "cloudflare:test";

// Test-only bindings, set in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
