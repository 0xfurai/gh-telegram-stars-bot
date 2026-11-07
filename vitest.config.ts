import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_SETTINGS } from "./test/settings.ts";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Valid Worker settings (fake values).
          ...TEST_SETTINGS,
          // Applied to the test database by test/apply-migrations.ts.
          TEST_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    // `bun run test:coverage`. Istanbul, because V8 coverage doesn't work in
    // the Workers runtime. Everything is measured, the copy scripts' untested
    // command-line entry points too, so the README badge is the honest total.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
